/**
 * AMBIGRAM — AI-driven Ambient Sound Generator
 * Physical Modeling + Analog Synthesis Engine
 * Web Audio API, pure synthesis — no samples
 *
 * Sound layers:
 *   Weather   — rain (light/heavy), waterfall, wind, thunder
 *   Nature    — birds (FM), bees (AM), crickets, frogs, dragonflies
 *   Everglades — swamp ambience, alligator rumble, great blue heron,
 *                night chorus, distant motorboat
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
//  NOISE BUFFER FACTORIES
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  TPDF DITHER — triangular probability density function
//  Converts 64-bit double computation → Float32 storage
//  with noise-shaped quantization error (no harmonic distortion)
// ─────────────────────────────────────────────

const F32_LSB = Math.pow(2, -23); // 1 ULP of Float32

function tpdf() {
  // Two independent uniform randoms → triangular distribution
  // Mean = 0, eliminates DC bias in quantization error
  return (Math.random() - Math.random()) * F32_LSB;
}

// ─────────────────────────────────────────────
//  NOISE BUFFER FACTORIES  (computed at 64-bit, dithered to Float32)
// ─────────────────────────────────────────────

function makeWhiteBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) + tpdf();
  return buf;
}

function makePinkBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Paul Kellet's refined pink noise — all arithmetic in 64-bit doubles
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
    b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
    b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
    d[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11 + tpdf();
    b6 = w * 0.115926;
  }
  return buf;
}

function makeBrownBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Brownian motion integration — accumulator stays in 64-bit
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;   // leaky integrator
    d[i] = last * 3.5 + tpdf();
  }
  return buf;
}

function applyBufferFade(buffer, fadeInMs = 0, fadeOutMs = fadeInMs) {
  const fadeInSamples = Math.max(0, Math.floor((fadeInMs / 1000) * buffer.sampleRate));
  const fadeOutSamples = Math.max(0, Math.floor((fadeOutMs / 1000) * buffer.sampleRate));

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    const n = data.length;

    for (let i = 0; i < fadeInSamples && i < n; i++) {
      data[i] *= i / Math.max(1, fadeInSamples);
    }

    for (let i = 0; i < fadeOutSamples && i < n; i++) {
      const idx = n - 1 - i;
      if (idx < 0) break;
      data[idx] *= i / Math.max(1, fadeOutSamples);
    }
  }

  return buffer;
}

// ─────────────────────────────────────────────
//  REVERB — synthetic exponential impulse response
// ─────────────────────────────────────────────

function makeReverb(ctx, decaySec = 2.8, predelayMs = 18) {
  const convolver = ctx.createConvolver();
  const sr = ctx.sampleRate;
  const len = sr * (decaySec + predelayMs / 1000);
  const pre = Math.floor((predelayMs / 1000) * sr);
  const impulse = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const ch = impulse.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = Math.max(0, i - pre) / (len - pre);
      ch[i] = i < pre ? 0 : (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
    }
  }
  convolver.buffer = impulse;
  return convolver;
}

// ─────────────────────────────────────────────
//  KARPLUS-STRONG  — physical string / drip model
//  Returns a short AudioBuffer of a plucked string
// ─────────────────────────────────────────────

function karplusStrong(ctx, freq, decay = 0.995, durationSec = 1.5) {
  const sr = ctx.sampleRate;
  const N = Math.round(sr / freq);
  const totalSamples = Math.round(sr * durationSec);
  const out = new Float32Array(totalSamples);
  // seed delay line with noise
  const delayLine = new Float32Array(N).map(() => Math.random() * 2 - 1);
  for (let i = 0; i < totalSamples; i++) {
    const idx = i % N;
    const next = (idx + 1) % N;
    // lowpass average feedback
    delayLine[idx] = decay * 0.5 * (delayLine[idx] + delayLine[next]);
    out[i] = delayLine[idx];
  }
  const buf = ctx.createBuffer(1, totalSamples, sr);
  buf.getChannelData(0).set(out);
  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SURROUND FORMATS — speaker positions in azimuth/elevation degrees
//  (0° azimuth = front-centre, CW positive; elevation 0° = ear level).
//  Channel order follows ITU-R / Dolby-style bed ordering where possible.
//  For 7.2.4 we duplicate the LFE feed to two channels; WAVE metadata can only
//  describe one standard LFE bit, so the second sub remains intentionally
//  unspecified in the channel mask.
// ─────────────────────────────────────────────────────────────────────────────
const SURROUND_FORMATS = {
  stereo: {
    key: "stereo", label: "Stereo", channels: 2,
    channelMask: 0x00000003,
    speakers: [
      { name: "L",   az:  -30, el: 0, lfe: false },
      { name: "R",   az:   30, el: 0, lfe: false },
    ],
  },
  "5.1": {
    key: "5.1", label: "5.1", channels: 6,
    channelMask: 0x0000003F,
    // ch0=L ch1=R ch2=C ch3=LFE ch4=Ls ch5=Rs
    speakers: [
      { name: "L",   az:  -30, el: 0, lfe: false },
      { name: "R",   az:   30, el: 0, lfe: false },
      { name: "C",   az:    0, el: 0, lfe: false },
      { name: "LFE", az:    0, el: 0, lfe: true  },
      { name: "Ls",  az: -110, el: 0, lfe: false },
      { name: "Rs",  az:  110, el: 0, lfe: false },
    ],
  },
  "7.1": {
    key: "7.1", label: "7.1", channels: 8,
    channelMask: 0x0000063F,
    // ch0=L ch1=R ch2=C ch3=LFE ch4=Ls ch5=Rs ch6=Lrs ch7=Rrs
    speakers: [
      { name: "L",   az:  -30, el: 0, lfe: false },
      { name: "R",   az:   30, el: 0, lfe: false },
      { name: "C",   az:    0, el: 0, lfe: false },
      { name: "LFE", az:    0, el: 0, lfe: true  },
      { name: "Ls",  az:  -90, el: 0, lfe: false },
      { name: "Rs",  az:   90, el: 0, lfe: false },
      { name: "Lrs", az: -150, el: 0, lfe: false },
      { name: "Rrs", az:  150, el: 0, lfe: false },
    ],
  },
  "7.1.2": {
    key: "7.1.2", label: "7.1.2", channels: 10,
    channelMask: 0x0000563F,
    // ch0-7 = 7.1 bed, ch8=Tfl ch9=Tfr
    speakers: [
      { name: "L",   az:  -30, el: 0,  lfe: false },
      { name: "R",   az:   30, el: 0,  lfe: false },
      { name: "C",   az:    0, el: 0,  lfe: false },
      { name: "LFE", az:    0, el: 0,  lfe: true  },
      { name: "Ls",  az:  -90, el: 0,  lfe: false },
      { name: "Rs",  az:   90, el: 0,  lfe: false },
      { name: "Lrs", az: -150, el: 0,  lfe: false },
      { name: "Rrs", az:  150, el: 0,  lfe: false },
      { name: "Tfl", az:  -35, el: 45, lfe: false },
      { name: "Tfr", az:   35, el: 45, lfe: false },
    ],
  },
  "7.1.4": {
    key: "7.1.4", label: "7.1.4", channels: 12,
    channelMask: 0x0002D63F,
    // ch0-7 = 7.1 bed, ch8=Tfl ch9=Tfr ch10=Tbl ch11=Tbr
    speakers: [
      { name: "L",   az:  -30, el: 0,  lfe: false },
      { name: "R",   az:   30, el: 0,  lfe: false },
      { name: "C",   az:    0, el: 0,  lfe: false },
      { name: "LFE", az:    0, el: 0,  lfe: true  },
      { name: "Ls",  az:  -90, el: 0,  lfe: false },
      { name: "Rs",  az:   90, el: 0,  lfe: false },
      { name: "Lrs", az: -150, el: 0,  lfe: false },
      { name: "Rrs", az:  150, el: 0,  lfe: false },
      { name: "Tfl", az:  -35, el: 45, lfe: false },
      { name: "Tfr", az:   35, el: 45, lfe: false },
      { name: "Tbl", az: -145, el: 45, lfe: false },
      { name: "Tbr", az:  145, el: 45, lfe: false },
    ],
  },
  "7.2.4": {
    key: "7.2.4", label: "7.2.4", channels: 13,
    channelMask: 0x0002D63F,
    // bed 7.1 + second LFE + four heights
    speakers: [
      { name: "L",    az:  -30, el: 0,  lfe: false },
      { name: "R",    az:   30, el: 0,  lfe: false },
      { name: "C",    az:    0, el: 0,  lfe: false },
      { name: "LFE1", az:    0, el: 0,  lfe: true  },
      { name: "Ls",   az:  -90, el: 0,  lfe: false },
      { name: "Rs",   az:   90, el: 0,  lfe: false },
      { name: "Lrs",  az: -150, el: 0,  lfe: false },
      { name: "Rrs",  az:  150, el: 0,  lfe: false },
      { name: "LFE2", az:    0, el: 0,  lfe: true  },
      { name: "Tfl",  az:  -35, el: 45, lfe: false },
      { name: "Tfr",  az:   35, el: 45, lfe: false },
      { name: "Tbl",  az: -145, el: 45, lfe: false },
      { name: "Tbr",  az:  145, el: 45, lfe: false },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  SurroundPanner — VBAP-style per-layer spatial processor
//
//  Signal flow:
//    input (stereo) → stereo→mono downmix → N×GainNode (per speaker) → ChannelMerger
//
//  The per-speaker gains are computed via a cosine panning law: a sound at
//  azimuth θ contributes to speaker S with gain = max(0, cos(Δ/120 × π/2)),
//  where Δ is the angular distance between source and speaker (clamped to 120°
//  half-spread so non-adjacent speakers get zero contribution).
//  Gains are constant-power normalised so total RMS ≈ 1.
// ─────────────────────────────────────────────────────────────────────────────
class SurroundPanner {
  constructor(ctx, merger, format, defaultAz = 0, defaultEl = 0) {
    this.ctx     = ctx;
    this.format  = format;
    this.azimuth = defaultAz;
    this.elevation = defaultEl;

    // Stereo input — Web Audio automatically downmixes to mono when connected
    // to a single-channel destination node.
    this.input = ctx.createGain();
    this.input.gain.value = 1;

    // One gain node per speaker channel, each forced to mono so the downmix
    // happens cleanly and the output routes to the right merger input.
    this._chGains = format.speakers.map((_, i) => {
      const g = ctx.createGain();
      g.channelCount     = 1;
      g.channelCountMode = "explicit";
      g.gain.value       = 0;
      this.input.connect(g);
      if (merger) g.connect(merger, 0, i); // mono → input i of merger
      return g;
    });

    this._update();
  }

  setAzimuth(az)    { this.azimuth    = az; this._update(); }
  setElevation(el)  { this.elevation  = el; this._update(); }

  _update() {
    const { speakers } = this.format;
    const az = this.azimuth;
    const el = this.elevation;

    const sourceVector = [
      Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180),
      Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180),
      Math.sin((el * Math.PI) / 180),
    ];

    // Raw cosine gains in 3D speaker space.
    const raw = speakers.map(s => {
      if (s.lfe) return 0.18; // fixed sub feed regardless of position
      const speakerEl = s.el ?? 0;
      const speakerVector = [
        Math.sin((s.az * Math.PI) / 180) * Math.cos((speakerEl * Math.PI) / 180),
        Math.cos((s.az * Math.PI) / 180) * Math.cos((speakerEl * Math.PI) / 180),
        Math.sin((speakerEl * Math.PI) / 180),
      ];
      const dot =
        sourceVector[0] * speakerVector[0] +
        sourceVector[1] * speakerVector[1] +
        sourceVector[2] * speakerVector[2];
      return Math.max(0, Math.pow(Math.max(0, dot), 1.35));
    });

    // Constant-power normalisation over non-LFE speakers
    const nonLfe = raw.filter((_, i) => !speakers[i].lfe);
    const rms    = Math.sqrt(nonLfe.reduce((a, v) => a + v * v, 0));
    const scale  = rms > 0 ? 0.85 / rms : 0;

    const t = this.ctx.currentTime + 0.04;
    raw.forEach((v, i) => {
      const target = speakers[i].lfe ? v : v * scale;
      this._chGains[i].gain.linearRampToValueAtTime(target, t);
    });
  }
}

// ─────────────────────────────────────────────
//  MASTER ENGINE
// ─────────────────────────────────────────────

// Default azimuth positions — spread layers naturally around the soundfield
const LAYER_DEFAULT_AZ = {
  rain:      0,    // overhead / centre front
  waterfall: -40,  // front-left
  wind:      180,  // enveloping rear
  thunder:   0,    // front centre
  surf:      20,   // front-right wash
  birds:     60,   // front-right
  bees:      -60,  // front-left
  crickets:  120,  // right surround
  cicadas:   95,   // high right surround
  frogs:     -120, // left surround
  drips:     -20,  // slight left
  creek:     -55,  // front-left stream
  fire:      -10,  // near-centre
  wolves:    145,  // far rear-right
  swamp:     150,  // rear-right
  owl:       -140, // rear-left perch
  mosquitoes: -85, // close left side
  heron:     30,   // right of centre
  gator:     -150, // rear-left
};

const LAYER_DEFAULT_EL = {
  rain:        55,
  waterfall:   8,
  wind:        28,
  thunder:     40,
  surf:        10,
  birds:       35,
  bees:        8,
  crickets:    0,
  cicadas:     18,
  frogs:       0,
  drips:       20,
  creek:       4,
  fire:        0,
  wolves:      0,
  swamp:       0,
  owl:         24,
  mosquitoes:  30,
  heron:       28,
  gator:       0,
};

const SYNTH_KEYS = [
  "rain","waterfall","wind","thunder","surf","birds","bees",
  "crickets","cicadas","frogs","drips","creek","fire","wolves",
  "swamp","owl","mosquitoes","heron","gator"
];

class AmbigramEngine {
  constructor() {
    this.ctx            = null;
    this.master         = null;
    this.reverbSend     = null;
    this.reverb         = null;
    this.drySend        = null;
    this.synths         = {};
    this.surroundPanners = {};
    this.ready          = false;
    this.sampleRate     = 96000;
    this.surroundFormat = SURROUND_FORMATS.stereo;
  }

  async teardown() {
    if (!this.ctx) return;
    Object.values(this.synths).forEach(s => { try { s.stop && s.stop(); } catch(_) {} });
    await this.ctx.close();
    this.ctx             = null;
    this.master          = null;
    this.reverbSend      = null;
    this.reverb          = null;
    this.drySend         = null;
    this.synths          = {};
    this.surroundPanners = {};
    this.ready           = false;
  }

  async init(sampleRate = this.sampleRate, surroundKey = "stereo") {
    if (this.ready) return;
    this.sampleRate     = sampleRate;
    this.surroundFormat = SURROUND_FORMATS[surroundKey] || SURROUND_FORMATS.stereo;
    const fmt = this.surroundFormat;
    const nCh = fmt.channels;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.actualSampleRate = this.ctx.sampleRate;

    // Master gain → destination
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;

    // ── Multichannel path ──────────────────────────────────────────────────
    if (nCh > 2) {
      try {
        this.ctx.destination.channelCount          = nCh;
        this.ctx.destination.channelCountMode      = "explicit";
        this.ctx.destination.channelInterpretation = "discrete";
        this.master.channelCount          = nCh;
        this.master.channelCountMode      = "explicit";
        this.master.channelInterpretation = "discrete";
      } catch (e) {
        console.warn("Multichannel destination unavailable, browser will downmix:", e);
      }
      // ChannelMerger collects per-speaker mono signals → N-channel stream
      const merger = this.ctx.createChannelMerger(nCh);
      merger.connect(this.master);
      this.master.connect(this.ctx.destination);

      // Per-synth surround panners (each routes its signal to all N speakers)
      this.surroundPanners = {};
      SYNTH_KEYS.forEach(key => {
        this.surroundPanners[key] = new SurroundPanner(
          this.ctx, merger, fmt, LAYER_DEFAULT_AZ[key] ?? 0, LAYER_DEFAULT_EL[key] ?? 0
        );
      });
      // Reverb panner — biased toward rear (180°) for envelopment
      const reverbPanner = new SurroundPanner(this.ctx, merger, fmt, 170, 22);
      reverbPanner.setAzimuth(170);
      reverbPanner.setElevation(22);

      this.reverb = makeReverb(this.ctx, 3.2);
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.22;
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(reverbPanner.input);

      const ctx = this.ctx;
      const rv  = this.reverbSend;
      this.synths = {
        rain:      new RainSynth(ctx,      this.surroundPanners.rain.input,      rv),
        waterfall: new WaterfallSynth(ctx, this.surroundPanners.waterfall.input, rv),
        wind:      new WindSynth(ctx,      this.surroundPanners.wind.input,      rv),
        thunder:   new ThunderSynth(ctx,   this.surroundPanners.thunder.input,   rv),
        surf:      new SurfSynth(ctx,      this.surroundPanners.surf.input,      rv),
        birds:     new BirdSynth(ctx,      this.surroundPanners.birds.input,     rv),
        bees:      new BeeSynth(ctx,       this.surroundPanners.bees.input,      rv),
        crickets:  new CricketSynth(ctx,   this.surroundPanners.crickets.input,  rv),
        cicadas:   new CicadaSynth(ctx,    this.surroundPanners.cicadas.input,   rv),
        frogs:     new FrogSynth(ctx,      this.surroundPanners.frogs.input,     rv),
        drips:     new WaterDripSynth(ctx, this.surroundPanners.drips.input,     rv),
        creek:     new CreekSynth(ctx,     this.surroundPanners.creek.input,     rv),
        fire:      new FireSynth(ctx,      this.surroundPanners.fire.input,      rv),
        wolves:    new WolfSynth(ctx,      this.surroundPanners.wolves.input,    rv),
        swamp:     new SwampSynth(ctx,     this.surroundPanners.swamp.input,     rv),
        owl:       new OwlSynth(ctx,       this.surroundPanners.owl.input,       rv),
        mosquitoes:new MosquitoSynth(ctx,  this.surroundPanners.mosquitoes.input,rv),
        heron:     new HeronSynth(ctx,     this.surroundPanners.heron.input,     rv),
        gator:     new GatorSynth(ctx,     this.surroundPanners.gator.input,     rv),
      };

    // ── Stereo path (unchanged) ────────────────────────────────────────────
    } else {
      this.master.connect(this.ctx.destination);

      this.reverb = makeReverb(this.ctx, 3.2);
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.22;
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.master);

      this.drySend = this.ctx.createGain();
      this.drySend.gain.value = 1.0;
      this.drySend.connect(this.master);

      const { ctx, drySend, reverbSend } = this;
      this.synths = {
        rain:      new RainSynth(ctx,      drySend, reverbSend),
        waterfall: new WaterfallSynth(ctx, drySend, reverbSend),
        wind:      new WindSynth(ctx,      drySend, reverbSend),
        thunder:   new ThunderSynth(ctx,   drySend, reverbSend),
        surf:      new SurfSynth(ctx,      drySend, reverbSend),
        birds:     new BirdSynth(ctx,      drySend, reverbSend),
        bees:      new BeeSynth(ctx,       drySend, reverbSend),
        crickets:  new CricketSynth(ctx,   drySend, reverbSend),
        cicadas:   new CicadaSynth(ctx,    drySend, reverbSend),
        frogs:     new FrogSynth(ctx,      drySend, reverbSend),
        drips:     new WaterDripSynth(ctx, drySend, reverbSend),
        creek:     new CreekSynth(ctx,     drySend, reverbSend),
        fire:      new FireSynth(ctx,      drySend, reverbSend),
        wolves:    new WolfSynth(ctx,      drySend, reverbSend),
        swamp:     new SwampSynth(ctx,     drySend, reverbSend),
        owl:       new OwlSynth(ctx,       drySend, reverbSend),
        mosquitoes:new MosquitoSynth(ctx,  drySend, reverbSend),
        heron:     new HeronSynth(ctx,     drySend, reverbSend),
        gator:     new GatorSynth(ctx,     drySend, reverbSend),
      };
    }

    this.ready = true;
  }

  setMasterVol(v) {
    if (!this.master) return;
    this.master.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.05);
  }

  setReverb(mix) {
    if (!this.reverbSend) return;
    this.reverbSend.gain.linearRampToValueAtTime(mix * 2.0, this.ctx.currentTime + 0.1);
  }

  // Move a layer to a new azimuth (degrees, 0 = front-centre, CW positive)
  setSurroundAz(layerId, az) {
    if (this.surroundPanners[layerId]) this.surroundPanners[layerId].setAzimuth(az);
  }

  // Return max channel count the hardware can deliver
  maxChannels() {
    return this.ctx?.destination?.maxChannelCount ?? 2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WAV ENCODER — 16-bit PCM, 24-bit PCM, 32-bit IEEE float, N channels
//
//  channels: Float64Array[]  — one array per channel, all same length
//  For N > 2: writes WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) with proper channel
//  mask so DAWs and Windows Media correctly map speakers.
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_MASKS = {
  1: 0x00000004,             // FC
  2: 0x00000003,             // FL FR
  6: 0x0000003F,             // FL FR FC LFE BL BR  (5.1)
  8: 0x0000063F,             // FL FR FC LFE BL BR SL SR  (7.1)
  10: 0x0000563F,            // 7.1.2 with top-front pair
  12: 0x0002D63F,            // 7.1.4 with top-front + top-back
  13: 0x0002D63F,            // 7.2.4, second LFE intentionally unspecified
};

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i));
}

// Write a GUID into DataView (little-endian as per Windows GUID format)
function writeGUID(view, offset, guid) {
  view.setUint32(offset,      guid[0], true);
  view.setUint16(offset + 4,  guid[1], true);
  view.setUint16(offset + 6,  guid[2], true);
  for (let i = 0; i < 8; i++) view.setUint8(offset + 8 + i, guid[3][i]);
}
const PCM_GUID   = [0x00000001, 0x0000, 0x0010, [0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71]];
const FLOAT_GUID = [0x00000003, 0x0000, 0x0010, [0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71]];

function encodeWAV(channels, sampleRate, bitDepth, channelMask = 0) {
  const nCh      = channels.length;
  const nFrames  = channels[0].length;
  const bps      = bitDepth === 24 ? 3 : bitDepth / 8;
  const block    = nCh * bps;
  const dataSize = nFrames * block;

  // Use EXTENSIBLE format for N ≠ 2 so channel mapping is explicit
  const useExt   = nCh !== 2;
  const fmtSize  = useExt ? 40 : 16;
  const headerSz = 12 + 8 + fmtSize + 8; // RIFF + fmt chunk + data header
  const buf  = new ArrayBuffer(headerSz + dataSize);
  const view = new DataView(buf);

  let o = 0;
  // RIFF
  writeString(view, o, "RIFF"); o += 4;
  view.setUint32(o, 4 + (8 + fmtSize) + (8 + dataSize), true); o += 4;
  writeString(view, o, "WAVE"); o += 4;
  // fmt chunk
  writeString(view, o, "fmt "); o += 4;
  view.setUint32(o, fmtSize, true); o += 4;
  view.setUint16(o, useExt ? 0xFFFE : (bitDepth === 32 ? 3 : 1), true); o += 2; // format tag
  view.setUint16(o, nCh, true); o += 2;
  view.setUint32(o, sampleRate, true); o += 4;
  view.setUint32(o, sampleRate * block, true); o += 4;
  view.setUint16(o, block, true); o += 2;
  view.setUint16(o, bitDepth, true); o += 2;
  if (useExt) {
    view.setUint16(o, 22, true); o += 2;                   // cbSize
    view.setUint16(o, bitDepth, true); o += 2;             // wValidBitsPerSample
    view.setUint32(o, channelMask || CHANNEL_MASKS[nCh] || 0, true); o += 4; // dwChannelMask
    writeGUID(view, o, bitDepth === 32 ? FLOAT_GUID : PCM_GUID); o += 16;
  }
  // data chunk
  writeString(view, o, "data"); o += 4;
  view.setUint32(o, dataSize, true); o += 4;

  // Interleaved sample data — all channels per frame
  for (let f = 0; f < nFrames; f++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][f]));
      if (bitDepth === 16) {
        view.setInt16(o, Math.round((s + tpdf() * 2) * 0x7FFF), true); o += 2;
      } else if (bitDepth === 24) {
        const v = Math.round((s + tpdf()) * 0x7FFFFF);
        view.setUint8(o,     v & 0xFF);
        view.setUint8(o + 1, (v >> 8)  & 0xFF);
        view.setUint8(o + 2, (v >> 16) & 0xFF);
        o += 3;
      } else {
        view.setFloat32(o, s, true); o += 4;
      }
    }
  }
  return buf;
}

function downloadWAV(arrayBuffer, filename) {
  const blob = new Blob([arrayBuffer], { type: "audio/wav" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECORDER NODE — taps master bus, accumulates N-channel PCM as Float64
//  Uses ScriptProcessorNode (deprecated but universally supported).
// ─────────────────────────────────────────────────────────────────────────────

class RecorderNode {
  constructor(ctx, sourceNode, nChannels = 2) {
    this.ctx         = ctx;
    this.nChannels   = nChannels;
    this.recording   = false;
    this._chunks     = Array.from({ length: nChannels }, () => []);
    this._totalFrames = 0;

    // Configure for N channels — ScriptProcessorNode max is 32
    const n = Math.min(nChannels, 32);
    this._proc = ctx.createScriptProcessor(2048, n, n);
    try {
      this._proc.channelCount          = n;
      this._proc.channelCountMode      = "explicit";
      this._proc.channelInterpretation = "discrete";
    } catch (_) {}

    this._proc.onaudioprocess = (e) => {
      if (!this.recording) return;
      const len = e.inputBuffer.getChannelData(0).length;
      for (let c = 0; c < n; c++) {
        const data = e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1));
        this._chunks[c].push(new Float64Array(data));
      }
      this._totalFrames += len;
    };

    sourceNode.connect(this._proc);
    this._proc.connect(ctx.destination);
  }

  start() {
    this._chunks     = Array.from({ length: this.nChannels }, () => []);
    this._totalFrames = 0;
    this.recording   = true;
  }

  stop() {
    this.recording = false;
    const out = this._chunks.map(chunkArr => {
      const flat = new Float64Array(this._totalFrames);
      let off = 0;
      for (const chunk of chunkArr) { flat.set(chunk, off); off += chunk.length; }
      return flat;
    });
    return { channels: out, frames: this._totalFrames };
  }

  destroy() { this._proc.disconnect(); }
}

// ─────────────────────────────────────────────
//  RAIN — pink noise surface + Karplus-Strong drops
// ─────────────────────────────────────────────

class RainSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;

    // Noise chain: pink → bandpass → highshelf → highpass → gain
    this.bp = ctx.createBiquadFilter();
    this.bp.type = "bandpass"; this.bp.frequency.value = 2800; this.bp.Q.value = 0.4;
    this.hs = ctx.createBiquadFilter();
    this.hs.type = "highshelf"; this.hs.frequency.value = 7000; this.hs.gain.value = 3;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass"; this.hp.frequency.value = 250;

    this.bp.connect(this.hs); this.hs.connect(this.hp);
    this.hp.connect(this.gainNode);
    this.gainNode.connect(dry); this.gainNode.connect(wet);

    this._noise = null; this._dropTimer = null;
  }

  start() {
    if (this.active) return; this.active = true;
    const buf = makePinkBuffer(this.ctx, 4);
    this._noise = this.ctx.createBufferSource();
    this._noise.buffer = buf; this._noise.loop = true;
    this._noise.connect(this.bp); this._noise.start();
    this.gainNode.gain.linearRampToValueAtTime(
      0.12 + 0.3 * this.level, this.ctx.currentTime + 1.5
    );
    this._scheduleDrop();
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._dropTimer);
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2);
    if (this._noise) { this._noise.stop(this.ctx.currentTime + 2.5); this._noise = null; }
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.08 + 0.32 * v, this.ctx.currentTime + 0.15);
  }

  _scheduleDrop() {
    if (!this.active) return;
    const ms = 30 + (1 - this.level) * 280 + Math.random() * 80;
    this._dropTimer = setTimeout(() => { this._drop(); this._scheduleDrop(); }, ms);
  }

  _drop() {
    const ctx = this.ctx; const t = ctx.currentTime;
    const freq = 600 + Math.random() * 2800;
    const buf = karplusStrong(ctx, freq, 0.980 + Math.random() * 0.015, 0.4);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.04 * this.level;
    src.connect(g); g.connect(this.gainNode);
    src.start(t); src.stop(t + 0.45);
  }
}

// ─────────────────────────────────────────────
//  WATERFALL — brown + pink noise resonator bank
// ─────────────────────────────────────────────

class WaterfallSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);

    // Three resonant bands simulate the layered roar
    // Store both filter and gain nodes for live param control
    this.bandGains = [];
    this.bands = [
      { f: 320, Q: 1.2 }, { f: 780, Q: 0.8 }, { f: 1800, Q: 0.6 },
      { f: 4200, Q: 0.5 }, { f: 9000, Q: 0.4 },
    ].map(({ f, Q }) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = Q;
      const g = ctx.createGain(); g.gain.value = f < 500 ? 0.9 : f < 2000 ? 0.6 : 0.35;
      bp.connect(g); g.connect(this.gainNode);
      this.bandGains.push(g);
      return bp;
    });

    this._sources = [];
  }

  start() {
    if (this.active) return; this.active = true;
    // Brown noise for low roar, pink for upper spray
    [makeBrownBuffer, makePinkBuffer].forEach((factory, idx) => {
      const buf = factory(this.ctx, 5);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = this.ctx.createGain(); g.gain.value = idx === 0 ? 1.0 : 0.55;
      src.connect(g);
      this.bands.forEach(bp => g.connect(bp));
      src.start(); this._sources.push(src);
    });
    this.gainNode.gain.linearRampToValueAtTime(0.1 + 0.4 * this.level, this.ctx.currentTime + 2);
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2.5);
    this._sources.forEach(s => s.stop(this.ctx.currentTime + 3));
    this._sources = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.08 + 0.42 * v, this.ctx.currentTime + 0.15);
  }
}

// ─────────────────────────────────────────────
//  WIND — LFO-modulated lowpass filtered noise
// ─────────────────────────────────────────────

class WindSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);

    // Ladder-style: two cascaded lowpass filters
    this.lp1 = ctx.createBiquadFilter(); this.lp1.type = "lowpass";
    this.lp1.frequency.value = 700; this.lp1.Q.value = 0.5;
    this.lp2 = ctx.createBiquadFilter(); this.lp2.type = "lowpass";
    this.lp2.frequency.value = 1200;
    this.lp1.connect(this.lp2); this.lp2.connect(this.gainNode);

    // LFO for filter sweep (gusts) — very slow so wind doesn't "vibrate"
    // 0.012 Hz ≈ one gust cycle every ~83 seconds; feels like real wind
    this.lfo = ctx.createOscillator(); this.lfo.type = "sine";
    this.lfo.frequency.value = 0.012;
    this.lfoGain = ctx.createGain(); this.lfoGain.gain.value = 400;
    this.lfo.connect(this.lfoGain); this.lfoGain.connect(this.lp1.frequency);
    this.lfo.start();

    // Second LFO for amplitude swell — also very slow (0.008 Hz ≈ 125 s)
    this.ampLfo = ctx.createOscillator(); this.ampLfo.type = "sine";
    this.ampLfo.frequency.value = 0.008;
    this.ampLfoGain = ctx.createGain(); this.ampLfoGain.gain.value = 0;
    this.ampLfo.connect(this.ampLfoGain);
    this.ampLfoGain.connect(this.gainNode.gain);
    this.ampLfo.start();

    // Third very-slow LFO for subtle timbral variation (0.005 Hz ≈ 200 s)
    this.lpLfo2 = ctx.createOscillator(); this.lpLfo2.type = "sine";
    this.lpLfo2.frequency.value = 0.005;
    this.lpLfo2Gain = ctx.createGain(); this.lpLfo2Gain.gain.value = 200;
    this.lpLfo2.connect(this.lpLfo2Gain); this.lpLfo2Gain.connect(this.lp2.frequency);
    this.lpLfo2.start();

    this._source = null;
  }

  start() {
    if (this.active) return; this.active = true;
    const buf = makeWhiteBuffer(this.ctx, 5);
    this._source = this.ctx.createBufferSource();
    this._source.buffer = buf; this._source.loop = true;
    this._source.connect(this.lp1); this._source.start();
    const base = 0.08 + 0.25 * this.level;
    this.gainNode.gain.linearRampToValueAtTime(base, this.ctx.currentTime + 2.5);
    this.ampLfoGain.gain.value = base * 0.4;
    this.lfoGain.gain.value = 300 + 500 * this.level;
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 3);
    if (this._source) { this._source.stop(this.ctx.currentTime + 3.5); this._source = null; }
  }

  setLevel(v) {
    this.level = v;
    if (this.active) {
      const base = 0.05 + 0.28 * v;
      this.gainNode.gain.linearRampToValueAtTime(base, this.ctx.currentTime + 0.2);
      this.ampLfoGain.gain.value = base * 0.4;
      this.lfoGain.gain.value = 250 + 600 * v;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  THUNDER — four-layer synthesis: crack → bang → rolling rumble → echo tails
//
//  Architecture:
//    _crack()  : sharp white-noise transient (close lightning only, dist < 0.5)
//    _bang()   : initial compression wave — brown noise through low BP, 80–330 ms
//    _rumble() : sustained low-frequency roar with rolling AM (0.3–1.5 Hz LFO)
//    _echo()   : 1–3 low-passed reflections arriving 300–800 ms apart
//
//  ALL GainNodes are created with gain.value = 0 and brought up via scheduled
//  ramps only — no setValueAtTime(nonZero) without a preceding zero — so there
//  is no transient click regardless of timing jitter or AudioContext state.
// ─────────────────────────────────────────────────────────────────────────────

class ThunderSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.dry = dry; this.wet = wet;
    this.level    = 1.0;
    this.distance = 0.45; // 0 = close/sharp, 1 = distant/rolling
    this.autoMin  = 8000;
    this.autoMax  = 33000;
    this._autoTimer = null; this.autoMode = false;
  }

  setLevel(v)    { this.level    = v; }
  setDistance(v) { this.distance = v; }

  trigger() {
    const ctx  = this.ctx;
    const t    = ctx.currentTime + 0.15;  // 150 ms look-ahead
    const dist = this.distance;
    const lvl  = this.level;
    const near = this._nearFactor(dist);
    // Rumble duration: close = shorter + more defined; distant = longer rolling
    const dur  = 2.5 + (1 + dist * 5) * (0.6 + Math.random() * 0.8);

    if (near > 0.12)                      this._crack(t, dist, lvl, near);
    this._bang(t + dist * 0.06, dist, lvl, near);
    this._rumble(t + 0.04, dur, dist, lvl, near);
    // 1–3 echo reflections; more when close (reflections are louder)
    const nEchoes = 1 + Math.floor((1.1 - dist) * 2 + Math.random() * 1.5);
    for (let i = 0; i < nEchoes; i++) {
      this._echo(t + 0.28 + i * (0.22 + Math.random() * 0.45), i, dist, lvl, near);
    }
  }

  _nearFactor(dist) {
    // Re-map the current thunder distance range (0.45..1) so "closest"
    // strikes still hit hard even though the slider no longer goes to 0.
    return Math.max(0, Math.min(1, 1 - ((dist - 0.45) / 0.55)));
  }

  // ── 1. Sharp crack: 15–30 ms burst of highpassed white noise
  _crack(t, dist, lvl, near) {
    const ctx      = this.ctx;
    const dur      = 0.014 + Math.random() * 0.014;
    const amp      = (0.18 + near * 0.92) * lvl;
    if (amp <= 0) return;

    const buf = applyBufferFade(makeWhiteBuffer(ctx, dur + 0.01), 1.5, 1.5);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 900 + Math.random() * 700;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";  lp.frequency.value = 9000;

    const env = ctx.createGain(); env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(hp); hp.connect(lp); lp.connect(env); env.connect(this.dry);
    src.start(t); src.stop(t + dur + 0.01);
  }

  // ── 2. Initial compression wave: brown noise, two resonant BPs, fast decay
  _bang(t, dist, lvl, near) {
    const ctx    = this.ctx;
    const dur    = 0.08 + (1 - dist) * 0.28;
    const amp    = (0.58 + near * 0.78) * lvl;

    const buf = applyBufferFade(makeBrownBuffer(ctx, dur + 0.06), 4, 6);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const bp1 = ctx.createBiquadFilter();
    bp1.type = "bandpass"; bp1.frequency.value = 55 + Math.random() * 55; bp1.Q.value = 1.8;
    const bp2 = ctx.createBiquadFilter();
    bp2.type = "bandpass"; bp2.frequency.value = 130 + Math.random() * 100; bp2.Q.value = 2.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.45;

    const env = ctx.createGain(); env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.016);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp1); bp1.connect(env);
    src.connect(bp2); bp2.connect(g2); g2.connect(env);
    env.connect(this.dry); env.connect(this.wet);
    src.start(t); src.stop(t + dur + 0.06);
  }

  // ── 3. Rolling rumble: modal resonators + slow AM for the "rolling" texture
  _rumble(t, dur, dist, lvl, near) {
    const ctx = this.ctx;
    const buf = applyBufferFade(makeBrownBuffer(ctx, dur + 1.5), 8, 12);
    const src = ctx.createBufferSource(); src.buffer = buf;

    // Modal resonators at thunderclap frequencies
    const modes = [28, 45, 68, 95, 138].map((freq, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq * (0.88 + 0.24 * Math.random());
      bp.Q.value = 2 + Math.random() * 3.5;
      const mg = ctx.createGain(); mg.gain.value = 0.6 - i * 0.1;
      src.connect(bp); bp.connect(mg);
      return mg;
    });

    // Rolling AM: oscillates between 0.6 and 1.0 at 0.3–1.5 Hz
    const amRate  = 0.3 + Math.random() * 1.2;
    const amOsc   = ctx.createOscillator(); amOsc.type = "sine";
    amOsc.frequency.value = amRate;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.2;  // ±0.2
    const rollG   = ctx.createGain(); rollG.gain.value = 0.8;    // DC = 0.8
    amOsc.connect(amDepth); amDepth.connect(rollG.gain);          // net: 0.6–1.0

    // Outer envelope — fade in then long slow decay
    const amp    = (0.36 + near * 0.62) * lvl;
    const envG   = ctx.createGain(); envG.gain.value = 0;
    envG.gain.setValueAtTime(0, t);
    envG.gain.linearRampToValueAtTime(amp, t + 0.35);
    // Mid-rumble swell ±15%
    const swell  = amp * (0.85 + Math.random() * 0.30);
    envG.gain.linearRampToValueAtTime(swell, t + dur * 0.35);
    envG.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    modes.forEach(mg => mg.connect(rollG));
    rollG.connect(envG);
    envG.connect(this.dry); envG.connect(this.wet);

    amOsc.start(t); amOsc.stop(t + dur + 1.5);
    src.start(t);   src.stop(t + dur + 1.5);
  }

  // ── 4. Echo reflections: each increasingly low-passed and quieter
  _echo(t, idx, dist, lvl, near) {
    const ctx    = this.ctx;
    const dur    = 0.12 + Math.random() * 0.22;
    const amp    = lvl * (0.16 + near * 0.16) * Math.pow(0.5, idx) * (0.55 + dist * 0.45);

    const buf = applyBufferFade(makeBrownBuffer(ctx, dur + 0.06), 4, 6);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = Math.max(80, 280 - idx * 70);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 45 + Math.random() * 40; bp.Q.value = 2.5;

    const env = ctx.createGain(); env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(amp, t + 0.022);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp); bp.connect(lp); lp.connect(env);
    env.connect(this.dry); env.connect(this.wet);
    src.start(t); src.stop(t + dur + 0.06);
  }

  setAutoMode(on) {
    this.autoMode = on;
    if (on) this._scheduleAuto(); else clearTimeout(this._autoTimer);
  }

  _scheduleAuto() {
    if (!this.autoMode) return;
    const delay = (this.autoMin || 8000) + Math.random() * ((this.autoMax || 33000) - (this.autoMin || 8000));
    this._autoTimer = setTimeout(() => { this.trigger(); this._scheduleAuto(); }, delay);
  }
}

// ─────────────────────────────────────────────
//  BIRDS — FM synthesis, randomised species
// ─────────────────────────────────────────────

const BIRD_SPECIES = [
  // [carrier_hz, mod_ratio, mod_depth, call_dur, chirps, interval_ms]
  { name: "wren",       c: 3200, mr: 2.1, md: 1800, dur: 0.12, chirps: 8,  gap: 40  },
  { name: "warbler",    c: 2800, mr: 1.5, md: 900,  dur: 0.18, chirps: 5,  gap: 70  },
  { name: "sparrow",    c: 2100, mr: 3.2, md: 1200, dur: 0.10, chirps: 12, gap: 30  },
  { name: "cardinal",   c: 1600, mr: 1.0, md: 600,  dur: 0.35, chirps: 3,  gap: 120 },
  { name: "mockingbird",c: 2400, mr: 1.8, md: 1400, dur: 0.14, chirps: 6,  gap: 55  },
  { name: "thrush",     c: 1900, mr: 2.5, md: 1100, dur: 0.22, chirps: 4,  gap: 90  },
];

class BirdSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.masterGain = ctx.createGain(); this.masterGain.gain.value = 0;
    this.masterGain.connect(dry); this.masterGain.connect(wet);
    this._timers = [];
  }

  start() {
    if (this.active) return; this.active = true;
    this.masterGain.gain.linearRampToValueAtTime(0.15 + 0.3 * this.level, this.ctx.currentTime + 1);
    this._scheduleBird();
  }

  stop() {
    if (!this.active) return; this.active = false;
    this._timers.forEach(t => clearTimeout(t));
    this._timers = [];
    this.masterGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2);
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.masterGain.gain.linearRampToValueAtTime(0.12 + 0.33 * v, this.ctx.currentTime + 0.2);
  }

  _scheduleBird() {
    if (!this.active) return;
    const delay = 800 + Math.random() * (5000 / (this.level + 0.2));
    const t = setTimeout(() => {
      if (this.active) { this._callBird(); this._scheduleBird(); }
    }, delay);
    this._timers.push(t);
  }

  _callBird() {
    const sp = BIRD_SPECIES[Math.floor(Math.random() * BIRD_SPECIES.length)];
    const ctx = this.ctx;
    // pitch randomisation per call ±15%
    const pitchMult = 0.85 + Math.random() * 0.3;

    for (let i = 0; i < sp.chirps; i++) {
      const startTime = ctx.currentTime + i * (sp.dur + sp.gap / 1000) + Math.random() * 0.02;
      const carrier = ctx.createOscillator(); carrier.type = "sine";
      carrier.frequency.value = sp.c * pitchMult;
      const modulator = ctx.createOscillator(); modulator.type = "sine";
      modulator.frequency.value = sp.c * pitchMult * sp.mr;
      const modGain = ctx.createGain(); modGain.gain.value = sp.md * pitchMult;
      modulator.connect(modGain); modGain.connect(carrier.frequency);

      const env = ctx.createGain(); env.gain.value = 0;
      const vol = 0.08 * this.level;
      env.gain.setValueAtTime(0, startTime);
      env.gain.linearRampToValueAtTime(vol, startTime + 0.01);
      env.gain.setValueAtTime(vol, startTime + sp.dur * 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, startTime + sp.dur);

      // slight vibrato
      const vib = ctx.createOscillator(); vib.type = "sine";
      vib.frequency.value = 6 + Math.random() * 3;
      const vibGain = ctx.createGain(); vibGain.gain.value = 15;
      vib.connect(vibGain); vibGain.connect(carrier.frequency);

      carrier.connect(env); env.connect(this.masterGain);
      modulator.start(startTime); vib.start(startTime);
      carrier.start(startTime);
      const end = startTime + sp.dur + 0.01;
      carrier.stop(end); modulator.stop(end); vib.stop(end);
    }
  }
}

// ─────────────────────────────────────────────
//  BEES — AM synthesis, detuned oscillator cluster
// ─────────────────────────────────────────────

class BeeSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._oscs = []; this._lfo = null;
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // 7 slightly detuned saw oscillators — analog swarm
    const baseFreq = 220;
    for (let i = 0; i < 7; i++) {
      const osc = ctx.createOscillator();
      osc.type = i < 4 ? "sawtooth" : "square";
      osc.frequency.value = baseFreq * (1 + (i - 3) * 0.007); // ±2% detune
      const oscGain = ctx.createGain(); oscGain.gain.value = 0.12;
      osc.connect(oscGain); oscGain.connect(this.gainNode);
      osc.start(); this._oscs.push(osc);
    }

    // AM envelope — wing beats at 200Hz
    this._lfo = ctx.createOscillator(); this._lfo.type = "sine";
    this._lfo.frequency.value = 210 + Math.random() * 40;
    this._lfoGain = ctx.createGain(); this._lfoGain.gain.value = 0.4;
    this._lfo.connect(this._lfoGain); this._lfoGain.connect(this.gainNode.gain);
    this._lfo.start();

    // Lowpass for buzz character
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.value = 1800; lp.Q.value = 1.5;
    this.gainNode.disconnect(); this.gainNode.connect(lp);
    lp.connect(dry); lp.connect(wet); this._lp = lp;

    this.gainNode.gain.linearRampToValueAtTime(0.08 + 0.18 * this.level, ctx.currentTime + 1.5);
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2);
    this._oscs.forEach(o => o.stop(this.ctx.currentTime + 2.5));
    if (this._lfo) this._lfo.stop(this.ctx.currentTime + 2.5);
    this._oscs = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.06 + 0.2 * v, this.ctx.currentTime + 0.15);
  }
}

// ─────────────────────────────────────────────
//  CRICKETS — pulsed sine AM, high frequency
// ─────────────────────────────────────────────

class CricketSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._oscs = []; this._lfos = [];
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // 3 cricket voices at different frequencies
    [4800, 5100, 4600].forEach((freq, i) => {
      const osc = ctx.createOscillator(); osc.type = "sine";
      osc.frequency.value = freq + i * 80;
      const g = ctx.createGain(); g.gain.value = 0;

      // Chirp rate LFO (~14Hz)
      const lfo = ctx.createOscillator(); lfo.type = "sine";
      lfo.frequency.value = 14 + i * 1.3;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.06;
      lfo.connect(lfoG); lfoG.connect(g.gain);

      osc.connect(g); g.connect(this.gainNode);
      osc.start(); lfo.start();
      this._oscs.push(osc); this._lfos.push(lfo);
    });

    this.gainNode.gain.linearRampToValueAtTime(0.1 + 0.25 * this.level, ctx.currentTime + 2);
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2);
    [...this._oscs, ...this._lfos].forEach(o => o.stop(this.ctx.currentTime + 2.5));
    this._oscs = []; this._lfos = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.08 + 0.28 * v, this.ctx.currentTime + 0.15);
  }
}

// ─────────────────────────────────────────────
//  FROGS — Everglades-style resonant croaks (FM + bandpass)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  FROG SPECIES — each has a distinct synthesis type
//   "harmonic"       — stacked sine harmonics through formant BP (bullfrog)
//   "pulsed"         — rapid individual pulse events = trill (green treefrog, chorus frog)
//   "pure"           — single sine with vibrato (spring peeper)
//   "noise_resonant" — white noise through sharp BP = bark (barking treefrog)
// ─────────────────────────────────────────────
const FROG_SPECIES = [
  {
    name: "bullfrog",        type: "harmonic",
    pitchLo: 90,  pitchHi: 150,
    harmAmps: [1.0, 0.52, 0.27, 0.11],   // f0, f0×2, f0×3, f0×4
    formantF: 175, formantQ: 7,
    attack: 0.04, decay: 0.4, release: 0.55,
    noise: 0.12,
    burstMin: 1, burstMax: 1, burstGap: 0,
  },
  {
    name: "green_treefrog",  type: "pulsed",
    pitchLo: 860, pitchHi: 1100,
    fmRatio: 1.22, fmDepth: 55,
    pulseDur: 0.024, pulseGap: 0.016,
    pulseMin: 3,  pulseMax: 7,
    formantF: 970, formantQ: 5,
    attack: 0.006, release: 0.015,
    noise: 0.07,
  },
  {
    name: "spring_peeper",   type: "pure",
    pitchLo: 2700, pitchHi: 3100,
    attack: 0.009, decay: 0.09, release: 0.18,
    noise: 0.02,
  },
  {
    name: "barking_treefrog", type: "noise_resonant",
    pitchLo: 480, pitchHi: 630,
    noiseQ: 20,
    attack: 0.01, release: 0.12,
    burstMin: 2, burstMax: 4, burstGap: 0.22,
  },
  {
    name: "chorus_frog",     type: "pulsed",
    pitchLo: 1080, pitchHi: 1350,
    fmRatio: 1.48, fmDepth: 92,
    pulseDur: 0.009, pulseGap: 0.007,
    pulseMin: 12, pulseMax: 22,
    formantF: 1200, formantQ: 4,
    attack: 0.003, release: 0.007,
    noise: 0.17,
  },
];

class FrogSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timers = [];
  }

  start() {
    if (this.active) return; this.active = true;
    this.gainNode.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 1);
    this._scheduleFrog();
  }

  stop() {
    if (!this.active) return; this.active = false;
    this._timers.forEach(t => clearTimeout(t)); this._timers = [];
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 2);
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.2);
  }

  _scheduleFrog() {
    if (!this.active) return;
    const delay = 400 + Math.random() * (3500 / (this.level + 0.4));
    const t = setTimeout(() => { if (this.active) { this._croak(); this._scheduleFrog(); } }, delay);
    this._timers.push(t);
  }

  _croak() {
    const sp  = FROG_SPECIES[Math.floor(Math.random() * FROG_SPECIES.length)];
    const t0  = this.ctx.currentTime + 0.06;
    const pitch = sp.pitchLo + Math.random() * (sp.pitchHi - sp.pitchLo);
    const lvl = 0.07 + 0.17 * this.level;

    if      (sp.type === "harmonic")       this._synthHarmonic(sp, t0, pitch, lvl);
    else if (sp.type === "pulsed")         this._synthPulsed(sp, t0, pitch, lvl);
    else if (sp.type === "pure")           this._synthPure(sp, t0, pitch, lvl);
    else if (sp.type === "noise_resonant") {
      const reps = sp.burstMin + Math.floor(Math.random() * (sp.burstMax - sp.burstMin + 1));
      for (let r = 0; r < reps; r++)
        this._synthNoiseResonant(sp, t0 + r * (sp.attack + sp.release + sp.burstGap), pitch, lvl);
    }
  }

  // ── Harmonic stack: multiple sine partials → formant filter (bullfrog)
  _synthHarmonic(sp, t0, pitch, lvl) {
    const ctx = this.ctx;
    const dur = sp.attack + sp.decay + sp.release;
    sp.harmAmps.forEach((amp, i) => {
      const osc = ctx.createOscillator(); osc.type = "sine";
      osc.frequency.value = pitch * (i + 1);
      const env = ctx.createGain(); env.gain.value = 0;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(lvl * amp, t0 + sp.attack);
      env.gain.setValueAtTime(lvl * amp * 0.85, t0 + sp.attack + sp.decay * 0.5);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = sp.formantF * (0.9 + 0.2 * Math.random());
      bp.Q.value = sp.formantQ;
      osc.connect(env); env.connect(bp); bp.connect(this.gainNode);
      osc.start(t0); osc.stop(t0 + dur + 0.06);
    });
    this._addNoise(sp.noise, t0, dur, pitch * 0.6, 2.5, lvl * 0.35);
  }

  // ── Pulse train: one oscillator node per pulse = authentic trill texture
  _synthPulsed(sp, t0, pitch, lvl) {
    const ctx = this.ctx;
    const n = sp.pulseMin + Math.floor(Math.random() * (sp.pulseMax - sp.pulseMin + 1));
    const step = sp.pulseDur + sp.pulseGap;
    for (let i = 0; i < n; i++) {
      const pt  = t0 + i * step;
      const osc = ctx.createOscillator(); osc.type = "sine";
      osc.frequency.value = pitch * (1 + (Math.random() - 0.5) * 0.018);
      if (sp.fmDepth) {
        const fmOsc = ctx.createOscillator(); fmOsc.type = "sine";
        fmOsc.frequency.value = pitch * sp.fmRatio;
        const fmG = ctx.createGain();
        fmG.gain.value = sp.fmDepth * (0.8 + 0.4 * Math.random());
        fmOsc.connect(fmG); fmG.connect(osc.frequency);
        fmOsc.start(pt); fmOsc.stop(pt + sp.pulseDur + 0.012);
      }
      const env = ctx.createGain(); env.gain.value = 0;
      env.gain.setValueAtTime(0, pt);
      env.gain.linearRampToValueAtTime(lvl, pt + sp.attack);
      env.gain.setValueAtTime(lvl, pt + sp.pulseDur - sp.release * 0.4);
      env.gain.linearRampToValueAtTime(0, pt + sp.pulseDur + sp.release);
      if (sp.formantF) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = sp.formantF; bp.Q.value = sp.formantQ;
        osc.connect(env); env.connect(bp); bp.connect(this.gainNode);
      } else {
        osc.connect(env); env.connect(this.gainNode);
      }
      osc.start(pt); osc.stop(pt + sp.pulseDur + sp.release + 0.012);
    }
    if (sp.noise > 0)
      this._addNoise(sp.noise, t0, n * step + sp.release, pitch * 0.7, 3, lvl * 0.45);
  }

  // ── Pure tone with vibrato (spring peeper)
  _synthPure(sp, t0, pitch, lvl) {
    const ctx = this.ctx;
    const dur = sp.attack + sp.decay + sp.release;
    const osc = ctx.createOscillator(); osc.type = "sine";
    osc.frequency.setValueAtTime(pitch, t0);
    osc.frequency.linearRampToValueAtTime(pitch * 1.018, t0 + sp.attack);
    osc.frequency.linearRampToValueAtTime(pitch * 0.988, t0 + sp.attack + sp.decay);
    const env = ctx.createGain(); env.gain.value = 0;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(lvl * 0.9, t0 + sp.attack);
    env.gain.setValueAtTime(lvl * 0.82, t0 + sp.attack + sp.decay * 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env); env.connect(this.gainNode);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
    if (sp.noise > 0) this._addNoise(sp.noise, t0, dur, pitch * 0.8, 4, lvl * 0.18);
  }

  // ── Noise through sharp resonant BP = "bark" / rasp (barking treefrog)
  _synthNoiseResonant(sp, t0, pitch, lvl) {
    const ctx = this.ctx;
    const dur = sp.attack + sp.release;
    const buf = makeWhiteBuffer(ctx, dur + 0.06);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp1 = ctx.createBiquadFilter();
    bp1.type = "bandpass"; bp1.frequency.value = pitch; bp1.Q.value = sp.noiseQ;
    const bp2 = ctx.createBiquadFilter();
    bp2.type = "bandpass"; bp2.frequency.value = pitch * 1.7; bp2.Q.value = sp.noiseQ * 0.5;
    const bp2g = ctx.createGain(); bp2g.gain.value = 0.28;
    const env = ctx.createGain(); env.gain.value = 0;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(lvl * 1.6, t0 + sp.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp1); bp1.connect(env);
    src.connect(bp2); bp2.connect(bp2g); bp2g.connect(env);
    env.connect(this.gainNode);
    src.start(t0); src.stop(t0 + dur + 0.06);
  }

  // ── Shared breathiness helper: filtered noise blended under tonal call
  _addNoise(amount, t0, dur, bpFreq, Q, lvl) {
    if (amount <= 0) return;
    const ctx = this.ctx;
    const buf = makeWhiteBuffer(ctx, dur + 0.06);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp  = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = bpFreq; bp.Q.value = Q;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(lvl * amount, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.02);
    src.connect(bp); bp.connect(g); g.connect(this.gainNode);
    src.start(t0); src.stop(t0 + dur + 0.08);
  }
}

// ─────────────────────────────────────────────
//  WATER DRIPS — Karplus-Strong physical model
// ─────────────────────────────────────────────

class WaterDripSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timer    = null;
    // Param defaults — overridden live via LAYER_PARAMS apply()
    this._rateScale = 1;
    this._pitchLow  = 300;
    this._pitchHigh = 1200;
    this._decay     = 0.992;
    this._tail      = 1.2;
  }

  start() {
    if (this.active) return; this.active = true;
    this.gainNode.gain.linearRampToValueAtTime(0.12 + 0.3 * this.level, this.ctx.currentTime + 0.5);
    this._schedule();
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._timer);
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 1);
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.1 + 0.32 * v, this.ctx.currentTime + 0.1);
  }

  _schedule() {
    if (!this.active) return;
    const baseMs = 400 + Math.random() * (3000 / (this.level + 0.15));
    const ms = baseMs / Math.max(0.1, this._rateScale);
    this._timer = setTimeout(() => { this._drip(); this._schedule(); }, ms);
  }

  _drip() {
    const ctx = this.ctx; const t = ctx.currentTime;
    const range = Math.max(10, this._pitchHigh - this._pitchLow);
    const freq  = this._pitchLow + Math.random() * range;
    const decay = Math.max(0.9, Math.min(0.9999, this._decay + (Math.random() - 0.5) * 0.005));
    const tail  = Math.max(0.1, this._tail);
    const buf   = karplusStrong(ctx, freq, decay, tail);
    const src   = ctx.createBufferSource(); src.buffer = buf;
    const g     = ctx.createGain(); g.gain.value = 0.25 * this.level;
    const env   = ctx.createGain();
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + tail * 1.1);
    src.connect(g); g.connect(env); env.connect(this.gainNode);
    src.start(t); src.stop(t + tail + 0.1);
  }
}

// ─────────────────────────────────────────────
//  SWAMP AMBIENCE — Everglades low drone + insects
// ─────────────────────────────────────────────

class SwampSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._oscs = []; this._lfos = []; this._noiseLp = null;
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // Low swamp drone — cluster of detuned triangle oscs
    [55, 55.3, 110, 164.8, 82.4].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i < 2 ? "triangle" : "sine";
      osc.frequency.value = freq;
      const lfo = ctx.createOscillator(); lfo.type = "sine";
      lfo.frequency.value = 0.03 + i * 0.01;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.4;
      lfo.connect(lfoG); lfoG.connect(osc.frequency);
      const g = ctx.createGain(); g.gain.value = 0.07;
      osc.connect(g); g.connect(this.gainNode);
      osc.start(); lfo.start();
      this._oscs.push(osc); this._lfos.push(lfo);
    });

    // Brown noise undertone — store noiseLp for live param control
    const brownBuf = makeBrownBuffer(ctx, 4);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = brownBuf; noiseSrc.loop = true;
    this._noiseLp = ctx.createBiquadFilter();
    this._noiseLp.type = "lowpass"; this._noiseLp.frequency.value = 180;
    const noiseG = ctx.createGain(); noiseG.gain.value = 0.15;
    noiseSrc.connect(this._noiseLp); this._noiseLp.connect(noiseG);
    noiseG.connect(this.gainNode);
    noiseSrc.start(); this._oscs.push(noiseSrc);

    this.gainNode.gain.linearRampToValueAtTime(0.12 + 0.28 * this.level, ctx.currentTime + 3);
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 3);
    [...this._oscs, ...this._lfos].forEach(o => { try { o.stop(this.ctx.currentTime + 3.5); } catch(_){} });
    this._oscs = []; this._lfos = []; this._noiseLp = null;
  }

  setLevel(v) {
    this.level = v;
    if (this.active)
      this.gainNode.gain.linearRampToValueAtTime(0.1 + 0.3 * v, this.ctx.currentTime + 0.2);
  }
}

// ─────────────────────────────────────────────
//  GREAT BLUE HERON — rasping FM squawk
// ─────────────────────────────────────────────

class HeronSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.6;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timer = null;
  }

  start() {
    if (this.active) return; this.active = true;
    this.gainNode.gain.value = this.level * 0.4;
    this._schedule();
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._timer);
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 1);
  }

  setLevel(v) { this.level = v; if (this.active) this.gainNode.gain.value = v * 0.4; }

  _schedule() {
    if (!this.active) return;
    const ms = 8000 + Math.random() * 20000;
    this._timer = setTimeout(() => { this._call(); this._schedule(); }, ms);
  }

  _call() {
    const ctx = this.ctx; const t = ctx.currentTime;
    // Harsh rasp: 3 squawks in succession
    for (let i = 0; i < 3; i++) {
      const t0 = t + i * 0.38;
      const c = ctx.createOscillator(); c.type = "sawtooth"; c.frequency.value = 280;
      c.frequency.linearRampToValueAtTime(180, t0 + 0.22);
      const m = ctx.createOscillator(); m.type = "sawtooth"; m.frequency.value = 420;
      const mG = ctx.createGain(); mG.gain.value = 320;
      m.connect(mG); mG.connect(c.frequency);
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.3, t0 + 0.03);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 400;
      c.connect(hp); hp.connect(env); env.connect(this.gainNode);
      c.start(t0); m.start(t0); c.stop(t0 + 0.3); m.stop(t0 + 0.3);
    }
  }
}

// ─────────────────────────────────────────────
//  ALLIGATOR RUMBLE — infrasonic territory call
// ─────────────────────────────────────────────

class GatorSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timer = null;
  }

  start() {
    if (this.active) return; this.active = true;
    this.gainNode.gain.value = this.level * 0.35;
    this._schedule();
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._timer);
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 1);
  }

  setLevel(v) { this.level = v; if (this.active) this.gainNode.gain.value = v * 0.35; }

  _schedule() {
    if (!this.active) return;
    const ms = 15000 + Math.random() * 45000;
    this._timer = setTimeout(() => { this._bellow(); this._schedule(); }, ms);
  }

  _bellow() {
    const ctx = this.ctx; const t = ctx.currentTime;
    const dur = 4 + Math.random() * 3;
    // Infrasonic rumble at 20–35 Hz with water-dance harmonics
    [22, 28, 44, 55, 88].forEach((freq, i) => {
      const osc = ctx.createOscillator(); osc.type = i < 2 ? "sine" : "triangle";
      osc.frequency.value = freq;
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime((0.35 - i * 0.05) * this.level, t + 0.5);
      env.gain.setValueAtTime((0.35 - i * 0.05) * this.level, t + dur - 1);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(env); env.connect(this.gainNode);
      osc.start(t); osc.stop(t + dur + 0.1);
    });

    // Bubble/churn noise burst
    const nBuf = makeBrownBuffer(ctx, Math.ceil(dur));
    const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
    const nLp = ctx.createBiquadFilter(); nLp.type = "lowpass"; nLp.frequency.value = 120;
    const nEnv = ctx.createGain(); nEnv.gain.setValueAtTime(0, t);
    nEnv.gain.linearRampToValueAtTime(0.2 * this.level, t + 0.3);
    nEnv.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    nSrc.connect(nLp); nLp.connect(nEnv); nEnv.connect(this.gainNode);
    nSrc.start(t); nSrc.stop(t + dur + 0.1);
  }
}

// ─────────────────────────────────────────────
//  CICADA CHORUS — AM-pulsed narrow-band noise, 3 voices
// ─────────────────────────────────────────────

class CicadaSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._srcs = []; this._amLfos = []; this._bps = [];
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;
    [4500, 4640, 4360].forEach((freq, i) => {
      const src = ctx.createBufferSource();
      src.buffer = makePinkBuffer(ctx, 4); src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 22;

      // Wing-beat AM: 28–35 Hz, each voice slightly offset
      const amLfo  = ctx.createOscillator();
      amLfo.type   = "sine";
      amLfo.frequency.value = 28 + i * 3.2 + Math.random();
      const amGain = ctx.createGain(); amGain.gain.value = 0.42;
      const amAmp  = ctx.createGain(); amAmp.gain.value  = 0.58;
      amLfo.connect(amGain); amGain.connect(amAmp.gain);

      src.connect(bp); bp.connect(amAmp); amAmp.connect(this.gainNode);
      src.start(); amLfo.start();
      this._srcs.push(src); this._amLfos.push(amLfo); this._bps.push(bp);
    });
    this.gainNode.gain.setTargetAtTime(this.level * 0.28, ctx.currentTime, 1.5);
  }

  stop() {
    if (!this.active) return; this.active = false;
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(0, t, 0.8);
    [...this._srcs, ...this._amLfos].forEach(n => { try { n.stop(t + 4); } catch(_) {} });
    this._srcs = []; this._amLfos = []; this._bps = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active) this.gainNode.gain.setTargetAtTime(v * 0.28, this.ctx.currentTime, 0.1);
  }
}

// ─────────────────────────────────────────────
//  OCEAN SURF — LFO-swept noise resonator + low boom
// ─────────────────────────────────────────────

class SurfSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._nodes = []; this._lfo = null; this._lfoGain = null; this._ampLfo = null;
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // Noise body
    const src = ctx.createBufferSource();
    src.buffer = makeBrownBuffer(ctx, 8); src.loop = true;

    // Sweep LPF — gives the rolling wave wash
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 800; lp.Q.value = 0.5;
    this._lp = lp;

    const lfo = ctx.createOscillator();
    lfo.type = "sine"; lfo.frequency.value = 0.11;
    this._lfo = lfo;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 600;
    this._lfoGain = lfoGain;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);

    // Amplitude swell (wave volume rises and falls)
    const ampLfo = ctx.createOscillator();
    ampLfo.type = "sine"; ampLfo.frequency.value = 0.095;
    this._ampLfo = ampLfo;
    const ampMod  = ctx.createGain(); ampMod.gain.value  = 0.26;
    const ampDC   = ctx.createGain(); ampDC.gain.value   = 0.74;
    ampLfo.connect(ampMod); ampMod.connect(ampDC.gain);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 55;

    src.connect(hp); hp.connect(lp); lp.connect(ampDC); ampDC.connect(this.gainNode);

    // Low breaking-wave boom
    const bSrc = ctx.createBufferSource();
    bSrc.buffer = makeBrownBuffer(ctx, 8); bSrc.loop = true;
    const bBp = ctx.createBiquadFilter();
    bBp.type = "bandpass"; bBp.frequency.value = 110; bBp.Q.value = 0.5;
    const bG = ctx.createGain(); bG.gain.value = 0.55;
    bSrc.connect(bBp); bBp.connect(bG); bG.connect(this.gainNode);

    src.start(); bSrc.start(); lfo.start(); ampLfo.start();
    this._nodes = [src, bSrc, lfo, ampLfo];
    this.gainNode.gain.setTargetAtTime(this.level * 0.45, ctx.currentTime, 2);
  }

  stop() {
    if (!this.active) return; this.active = false;
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(0, t, 1.5);
    this._nodes.forEach(n => { try { n.stop(t + 6); } catch(_) {} });
    this._nodes = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active) this.gainNode.gain.setTargetAtTime(v * 0.45, this.ctx.currentTime, 0.15);
  }
}

// ─────────────────────────────────────────────
//  OWL CALL — FM "hoo-HOO-hoo" great-horned hoot
// ─────────────────────────────────────────────

class OwlSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timer = null;
    this._intervalMult = 1;
    this._pitchBase    = 280;
  }

  start() { if (this.active) return; this.active = true; this._schedule(); }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._timer);
    this.gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
  }

  setLevel(v) { this.level = v; }

  _schedule() {
    if (!this.active) return;
    // Great horned owl: 1–4 minutes between calls
    const ms = (60000 + Math.random() * 180000) * this._intervalMult;
    this._timer = setTimeout(() => { this._call(); this._schedule(); }, ms);
  }

  _hoot(t, freq, dur, vol) {
    const ctx = this.ctx;
    const mod = ctx.createOscillator(); mod.type = "sine";
    mod.frequency.value = freq * 1.004;
    const modGain = ctx.createGain(); modGain.gain.value = freq * 0.09;
    mod.connect(modGain);

    const car = ctx.createOscillator(); car.type = "sine";
    car.frequency.value = freq;
    modGain.connect(car.frequency);

    const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 5.5;
    const vibG = ctx.createGain(); vibG.gain.value = 5;
    vib.connect(vibG); vibG.connect(car.frequency);

    const env = ctx.createGain(); env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.06);
    env.gain.setValueAtTime(vol, t + dur - 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    car.connect(env); env.connect(this.gainNode);
    [car, mod, vib].forEach(n => { n.start(t); n.stop(t + dur + 0.05); });
  }

  _call() {
    const t = this.ctx.currentTime + 0.1;
    const p = this._pitchBase; const v = this.level * 0.55;
    // "hoo — hoo-HOO — hoo-hoo"
    this._hoot(t,        p,        0.45, v * 0.70);
    this._hoot(t + 0.65, p,        0.35, v * 0.70);
    this._hoot(t + 1.10, p * 1.04, 0.55, v);
    this._hoot(t + 1.80, p,        0.35, v * 0.70);
    this._hoot(t + 2.25, p,        0.40, v * 0.75);
  }
}

// ─────────────────────────────────────────────
//  CAMPFIRE — filtered crackle body + random pops
// ─────────────────────────────────────────────

class FireSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._srcs = []; this._popTimer = null;
    this._lp = null; this._popRateScale = 1;
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // Crackle body: bandpassed white noise
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = makeWhiteBuffer(ctx, 4); wSrc.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";  lp.frequency.value = 3500;
    this._lp = lp;
    const cracklG = ctx.createGain(); cracklG.gain.value = 0.18;

    // Flame flicker AM at ~0.8 Hz
    const flameLfo = ctx.createOscillator(); flameLfo.type = "sine"; flameLfo.frequency.value = 0.8;
    const flameM   = ctx.createGain(); flameM.gain.value  = 0.12;
    const flameAmp = ctx.createGain(); flameAmp.gain.value = 0.88;
    flameLfo.connect(flameM); flameM.connect(flameAmp.gain);

    wSrc.connect(hp); hp.connect(lp); lp.connect(cracklG); cracklG.connect(flameAmp);
    flameAmp.connect(this.gainNode);

    // Bed of coals: low rumble
    const bSrc = ctx.createBufferSource();
    bSrc.buffer = makeBrownBuffer(ctx, 4); bSrc.loop = true;
    const bBp = ctx.createBiquadFilter(); bBp.type = "bandpass"; bBp.frequency.value = 180; bBp.Q.value = 0.8;
    const bG  = ctx.createGain(); bG.gain.value = 0.22;
    bSrc.connect(bBp); bBp.connect(bG); bG.connect(this.gainNode);

    wSrc.start(); bSrc.start(); flameLfo.start();
    this._srcs = [wSrc, bSrc, flameLfo];
    this.gainNode.gain.setTargetAtTime(this.level * 0.35, ctx.currentTime, 1.0);
    this._popLoop();
  }

  _popLoop() {
    if (!this.active) return;
    const ms = (300 + Math.random() * 1800) / this._popRateScale;
    this._popTimer = setTimeout(() => { if (this.active) { this._pop(); this._popLoop(); } }, ms);
  }

  _pop() {
    const ctx = this.ctx; const t = ctx.currentTime + 0.02;
    const freq = 600 + Math.random() * 2200;
    const dur  = 0.018 + Math.random() * 0.045;
    const src  = ctx.createBufferSource(); src.buffer = makeWhiteBuffer(ctx, 0.1);
    const bp   = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 9;
    const env  = ctx.createGain(); env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(this.level * 0.85, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(env); env.connect(this.gainNode);
    src.start(t); src.stop(t + dur + 0.02);
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._popTimer);
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(0, t, 1.0);
    this._srcs.forEach(n => { try { n.stop(t + 4); } catch(_) {} });
    this._srcs = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active) this.gainNode.gain.setTargetAtTime(v * 0.35, this.ctx.currentTime, 0.1);
  }
}

// ─────────────────────────────────────────────
//  WOLF HOWL — pitch-sweeping sawtooth FM
// ─────────────────────────────────────────────

class WolfSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._timer = null;
    this._intervalMult = 1;
    this._pitchBase    = 220;
  }

  start() { if (this.active) return; this.active = true; this._schedule(); }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._timer);
    this.gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.5);
  }

  setLevel(v) { this.level = v; }

  _schedule() {
    if (!this.active) return;
    // Wolves howl every 3–8 minutes
    const ms = (180000 + Math.random() * 300000) * this._intervalMult;
    this._timer = setTimeout(() => { this._pack(); this._schedule(); }, ms);
  }

  _howl(t, startPitch, peakPitch, dur, vol) {
    const ctx = this.ctx;
    const mod = ctx.createOscillator(); mod.type = "sine";
    mod.frequency.setValueAtTime(startPitch * 0.5, t);
    mod.frequency.linearRampToValueAtTime(peakPitch * 0.5, t + dur * 0.4);
    const modGain = ctx.createGain(); modGain.gain.value = startPitch * 1.1;
    mod.connect(modGain);

    const car = ctx.createOscillator(); car.type = "sawtooth";
    car.frequency.setValueAtTime(startPitch, t);
    car.frequency.linearRampToValueAtTime(peakPitch,        t + dur * 0.35);
    car.frequency.setValueAtTime(peakPitch,                 t + dur * 0.60);
    car.frequency.linearRampToValueAtTime(peakPitch * 0.91, t + dur);
    modGain.connect(car.frequency);

    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200;

    const env = ctx.createGain(); env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.3);
    env.gain.setValueAtTime(vol, t + dur - 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    car.connect(lp); lp.connect(env); env.connect(this.gainNode);
    car.start(t); mod.start(t); car.stop(t + dur + 0.1); mod.stop(t + dur + 0.1);
  }

  _pack() {
    const t = this.ctx.currentTime + 0.1;
    const p = this._pitchBase; const v = this.level * 0.65;
    const nWolves = Math.random() < 0.4 ? 2 : 1;
    for (let i = 0; i < nWolves; i++) {
      const off   = i * (0.8 + Math.random() * 1.2);
      const pitch = p * (0.88 + Math.random() * 0.28);
      this._howl(t + off, pitch * 0.68, pitch, 4 + Math.random() * 3, v * (0.7 + Math.random() * 0.3));
    }
  }
}

// ─────────────────────────────────────────────
//  MOSQUITO — near-ear high-frequency whine
// ─────────────────────────────────────────────

class MosquitoSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._oscs = []; this._lfos = [];
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    [420, 435, 450].forEach((freq, i) => {
      const osc = ctx.createOscillator(); osc.type = "sine";
      osc.frequency.value = freq;

      // Very slow drift so pitches wander slightly (±5 Hz)
      const drift = ctx.createOscillator(); drift.type = "sine";
      drift.frequency.value = 0.07 + i * 0.03;
      const driftG = ctx.createGain(); driftG.gain.value = 5 + i * 1.5;
      drift.connect(driftG); driftG.connect(osc.frequency);

      // Slow proximity AM (0.3–0.8 Hz — buzz coming closer/farther)
      const prox  = ctx.createOscillator(); prox.type = "sine"; prox.frequency.value = 0.3 + i * 0.18;
      const proxM = ctx.createGain(); proxM.gain.value = 0.25;
      const proxA = ctx.createGain(); proxA.gain.value = 0.75;
      prox.connect(proxM); proxM.connect(proxA.gain);
      osc.connect(proxA); proxA.connect(this.gainNode);

      osc.start(); drift.start(); prox.start();
      this._oscs.push(osc); this._lfos.push(drift, prox);
    });

    this.gainNode.gain.setTargetAtTime(this.level * 0.07, ctx.currentTime, 0.5);
  }

  stop() {
    if (!this.active) return; this.active = false;
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(0, t, 0.3);
    [...this._oscs, ...this._lfos].forEach(n => { try { n.stop(t + 1); } catch(_) {} });
    this._oscs = []; this._lfos = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active) this.gainNode.gain.setTargetAtTime(v * 0.07, this.ctx.currentTime, 0.1);
  }
}

// ─────────────────────────────────────────────
//  CREEK — babbling brook, 4-band resonator with random-walk band tuning
// ─────────────────────────────────────────────

class CreekSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.active = false; this.level = 0.5;
    this.gainNode = ctx.createGain(); this.gainNode.gain.value = 0;
    this.gainNode.connect(dry); this.gainNode.connect(wet);
    this._srcs = []; this._bps = []; this._rwTimer = null;
    this._rwSpeed = 1;
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;
    const wBuf = makeWhiteBuffer(ctx, 8);
    const bBuf = makeBrownBuffer(ctx, 8);

    [
      { fc: 320,  q: 1.2, amp: 0.90, noise: "brown" },
      { fc: 700,  q: 1.0, amp: 0.65, noise: "brown" },
      { fc: 1800, q: 0.8, amp: 0.40, noise: "white" },
      { fc: 4200, q: 0.6, amp: 0.22, noise: "white" },
    ].forEach(({ fc, q, amp, noise }) => {
      const src = ctx.createBufferSource();
      src.buffer = noise === "brown" ? bBuf : wBuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = fc; bp.Q.value = q;
      const g = ctx.createGain(); g.gain.value = amp;
      src.connect(bp); bp.connect(g); g.connect(this.gainNode);
      src.start();
      this._srcs.push(src); this._bps.push(bp);
    });

    this.gainNode.gain.setTargetAtTime(this.level * 0.42, ctx.currentTime, 1.5);
    this._rwalk();
  }

  _rwalk() {
    if (!this.active) return;
    this._bps.forEach(bp => {
      const cur  = bp.frequency.value;
      const step = cur * (Math.random() * 0.16 - 0.08); // ±8%
      bp.frequency.setTargetAtTime(
        Math.max(100, Math.min(8000, cur + step)),
        this.ctx.currentTime, 1.2
      );
    });
    this._rwTimer = setTimeout(() => this._rwalk(), (1800 + Math.random() * 1600) / this._rwSpeed);
  }

  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this._rwTimer);
    const t = this.ctx.currentTime;
    this.gainNode.gain.setTargetAtTime(0, t, 1.0);
    this._srcs.forEach(n => { try { n.stop(t + 4); } catch(_) {} });
    this._srcs = []; this._bps = [];
  }

  setLevel(v) {
    this.level = v;
    if (this.active) this.gainNode.gain.setTargetAtTime(v * 0.42, this.ctx.currentTime, 0.1);
  }
}

// ─────────────────────────────────────────────
//  SCENE PRESETS
// ─────────────────────────────────────────────

const PRESETS = {
  "Everglades Dusk": {
    swamp: 0.7, frogs: 0.8, crickets: 0.6, birds: 0.4,
    gator: 0.5, heron: 0.5, wind: 0.2, drips: 0.3,
    rain: 0, waterfall: 0, thunder: false, bees: 0.2,
  },
  "Monsoon Rain": {
    rain: 0.85, thunder: true, wind: 0.6, waterfall: 0.3,
    birds: 0.1, frogs: 0.5, swamp: 0.2,
    crickets: 0, bees: 0, gator: 0, heron: 0, drips: 0.4,
  },
  "Forest Morning": {
    birds: 0.8, crickets: 0.3, wind: 0.3, drips: 0.4,
    bees: 0.5, waterfall: 0.4,
    rain: 0, thunder: false, frogs: 0.2, swamp: 0, gator: 0, heron: 0.3,
  },
  "Waterfall Gorge": {
    waterfall: 0.9, wind: 0.3, drips: 0.6, birds: 0.4,
    rain: 0, thunder: false, frogs: 0.15, crickets: 0.2,
    bees: 0.1, swamp: 0, gator: 0, heron: 0,
  },
  "Night Swamp": {
    swamp: 0.8, frogs: 0.9, crickets: 0.8, gator: 0.6,
    wind: 0.15, drips: 0.2,
    rain: 0, thunder: false, birds: 0, bees: 0, waterfall: 0, heron: 0,
  },
  "Bee Meadow": {
    bees: 0.8, birds: 0.6, wind: 0.4, crickets: 0.3,
    drips: 0.2, waterfall: 0.2,
    rain: 0, thunder: false, frogs: 0, swamp: 0, gator: 0, heron: 0,
  },
  "Coastal Night": {
    surf: 0.85, wind: 0.35, creek: 0.2, owl: 0.35,
    mosquitoes: 0.18, frogs: 0.2, crickets: 0.25,
    rain: 0, waterfall: 0, thunder: false, birds: 0.1, bees: 0,
    drips: 0, swamp: 0, wolves: 0, fire: 0, cicadas: 0.15, heron: 0, gator: 0,
  },
  "Campfire Creek": {
    fire: 0.82, creek: 0.78, owl: 0.28, wolves: 0.14,
    wind: 0.15, drips: 0.12, cicadas: 0.22,
    rain: 0, waterfall: 0, thunder: false, birds: 0.08, bees: 0,
    crickets: 0.18, frogs: 0.08, swamp: 0, mosquitoes: 0.05, heron: 0, gator: 0, surf: 0,
  },
  "Summer Chorus": {
    cicadas: 0.9, crickets: 0.45, frogs: 0.32, mosquitoes: 0.25,
    creek: 0.32, birds: 0.18, wind: 0.12,
    rain: 0, waterfall: 0, thunder: false, bees: 0.06, drips: 0,
    swamp: 0, fire: 0, wolves: 0, owl: 0, heron: 0, gator: 0, surf: 0,
  },
};

// ─────────────────────────────────────────────
//  LAYER DEFINITIONS (UI metadata + per-layer param sliders)
// ─────────────────────────────────────────────

// Each param: { id, label, min, max, step, default, unit }
// These drive the synth's audio-param nodes in real time via setParam().
const LAYER_PARAMS = {
  rain: [
    { id: "bpFreq",    label: "Texture Freq", min: 800,  max: 8000, step: 50,  default: 2800, unit: "Hz",
      apply: (s, v) => s.bp && (s.bp.frequency.value = v) },
    { id: "bpQ",       label: "Texture Q",    min: 0.1,  max: 4,    step: 0.05, default: 0.4,  unit: "",
      apply: (s, v) => s.bp && (s.bp.Q.value = v) },
    { id: "hpFreq",    label: "Low Cut",      min: 60,   max: 800,  step: 10,  default: 250,  unit: "Hz",
      apply: (s, v) => s.hp && (s.hp.frequency.value = v) },
    { id: "hfGain",    label: "Air",          min: -6,   max: 12,   step: 0.5, default: 3,    unit: "dB",
      apply: (s, v) => s.hs && (s.hs.gain.value = v) },
    { id: "dropVol",   label: "Drop Vol",     min: 0,    max: 1,    step: 0.01,default: 0.04, unit: "",
      apply: (s, v) => s._dropVolScale = v },
  ],
  waterfall: [
    { id: "band0g",    label: "Roar (320Hz)", min: 0,    max: 2,    step: 0.05, default: 0.9, unit: "",
      apply: (s, v) => s.bandGains?.[0] && (s.bandGains[0].gain.value = v) },
    { id: "band1g",    label: "Body (780Hz)", min: 0,    max: 2,    step: 0.05, default: 0.6, unit: "",
      apply: (s, v) => s.bandGains?.[1] && (s.bandGains[1].gain.value = v) },
    { id: "band2g",    label: "Mid (1.8k)",   min: 0,    max: 2,    step: 0.05, default: 0.35,unit: "",
      apply: (s, v) => s.bandGains?.[2] && (s.bandGains[2].gain.value = v) },
    { id: "band3g",    label: "Spray (4.2k)", min: 0,    max: 2,    step: 0.05, default: 0.25,unit: "",
      apply: (s, v) => s.bandGains?.[3] && (s.bandGains[3].gain.value = v) },
    { id: "band4g",    label: "Mist (9k)",    min: 0,    max: 2,    step: 0.05, default: 0.15,unit: "",
      apply: (s, v) => s.bandGains?.[4] && (s.bandGains[4].gain.value = v) },
  ],
  wind: [
    { id: "lp1Freq",   label: "Cutoff",       min: 100,  max: 3000, step: 20,  default: 700,  unit: "Hz",
      apply: (s, v) => s.lp1 && (s.lp1.frequency.value = v) },
    { id: "lfoRate",   label: "Gust Rate",    min: 0.01, max: 0.8,  step: 0.01,default: 0.08, unit: "Hz",
      apply: (s, v) => s.lfo && (s.lfo.frequency.value = v) },
    { id: "lfoDepth",  label: "Gust Depth",   min: 0,    max: 1200, step: 20,  default: 500,  unit: "Hz",
      apply: (s, v) => s.lfoGain && (s.lfoGain.gain.value = v) },
    { id: "ampRate",   label: "Swell Rate",   min: 0.01, max: 0.3,  step: 0.005,default: 0.04,unit: "Hz",
      apply: (s, v) => s.ampLfo && (s.ampLfo.frequency.value = v) },
  ],
  thunder: [
    { id: "level",     label: "Strike Vol",   min: 0,    max: 1.6,  step: 0.01, default: 1.0,  unit: "",
      apply: (s, v) => s.setLevel(v) },
    { id: "distance",  label: "Distance",     min: 0.45, max: 1,    step: 0.01, default: 0.45, unit: "",
      apply: (s, v) => s.setDistance(v) },
    { id: "autoMin",   label: "Auto Min",     min: 4,    max: 60,   step: 1,    default: 8,    unit: "s",
      apply: (s, v) => (s.autoMin = v * 1000) },
    { id: "autoMax",   label: "Auto Max",     min: 10,   max: 120,  step: 1,    default: 33,   unit: "s",
      apply: (s, v) => (s.autoMax = v * 1000) },
  ],
  surf: [
    { id: "washTone",  label: "Wash Tone",    min: 250,  max: 1800, step: 25,   default: 800,  unit: "Hz",
      apply: (s, v) => s._lp && (s._lp.frequency.value = v) },
  ],
  birds: [
    { id: "callRate",  label: "Call Rate",    min: 0.1,  max: 2,    step: 0.05, default: 1,   unit: "×",
      apply: (s, v) => (s._rateScale = v) },
    { id: "pitchMult", label: "Pitch",        min: 0.5,  max: 2,    step: 0.01, default: 1,   unit: "×",
      apply: (s, v) => (s._pitchMult = v) },
    { id: "vibratoD",  label: "Vibrato",      min: 0,    max: 60,   step: 1,    default: 15,  unit: "Hz",
      apply: (s, v) => (s._vibratoDepth = v) },
    { id: "chirpGap",  label: "Chirp Gap",    min: 0.5,  max: 3,    step: 0.1,  default: 1,   unit: "×",
      apply: (s, v) => (s._chirpGapMult = v) },
  ],
  bees: [
    { id: "wingSp",    label: "Wing Speed",   min: 100,  max: 400,  step: 5,    default: 210, unit: "Hz",
      apply: (s, v) => s._lfo && (s._lfo.frequency.value = v) },
    { id: "buzzFreq",  label: "Buzz Pitch",   min: 100,  max: 500,  step: 5,    default: 220, unit: "Hz",
      apply: (s, v) => s._oscs && s._oscs.forEach((o, i) => (o.frequency.value = v * (1 + (i-3)*0.007))) },
    { id: "lpFreq",    label: "Buzz Color",   min: 400,  max: 5000, step: 50,   default: 1800,unit: "Hz",
      apply: (s, v) => s._lp && (s._lp.frequency.value = v) },
    { id: "amDepth",   label: "AM Depth",     min: 0,    max: 0.8,  step: 0.01, default: 0.4, unit: "",
      apply: (s, v) => s._lfoGain && (s._lfoGain.gain.value = v) },
  ],
  crickets: [
    { id: "chirpRate", label: "Chirp Rate",   min: 4,    max: 30,   step: 0.5,  default: 14,  unit: "Hz",
      apply: (s, v) => s._lfos && s._lfos.forEach((l, i) => (l.frequency.value = v + i*1.3)) },
    { id: "pitch",     label: "Pitch",        min: 3000, max: 8000, step: 100,  default: 4800,unit: "Hz",
      apply: (s, v) => s._oscs && s._oscs.forEach((o, i) => (o.frequency.value = v + i*300)) },
    { id: "spread",    label: "Voice Spread", min: 0,    max: 600,  step: 20,   default: 300, unit: "Hz",
      apply: (s, v) => s._oscs && s._oscs.forEach((o, i) => (o.frequency.value = (s._basePitch||4800) + i*v/3)) },
  ],
  cicadas: [
    { id: "bodyQ",     label: "Buzz Focus",   min: 8,    max: 35,   step: 1,    default: 22,   unit: "",
      apply: (s, v) => s._bps && s._bps.forEach(bp => (bp.Q.value = v)) },
  ],
  frogs: [
    { id: "callRate",  label: "Call Rate",    min: 0.2,  max: 3,    step: 0.1,  default: 1,   unit: "×",
      apply: (s, v) => (s._rateScale = v) },
    { id: "pitchMult", label: "Pitch",        min: 0.5,  max: 1.8,  step: 0.01, default: 1,   unit: "×",
      apply: (s, v) => (s._pitchMult = v) },
    { id: "resonQ",    label: "Body Resonance", min: 1,  max: 20,   step: 0.5,  default: 6,   unit: "",
      apply: (s, v) => (s._resonQ = v) },
  ],
  drips: [
    { id: "rateScale", label: "Drip Rate",    min: 0.1,  max: 4,    step: 0.1,  default: 1,   unit: "×",
      apply: (s, v) => (s._rateScale = v) },
    { id: "pitchLow",  label: "Pitch Low",    min: 80,   max: 800,  step: 20,   default: 300, unit: "Hz",
      apply: (s, v) => (s._pitchLow = v) },
    { id: "pitchHigh", label: "Pitch High",   min: 400,  max: 4000, step: 50,   default: 1200,unit: "Hz",
      apply: (s, v) => (s._pitchHigh = v) },
    { id: "decay",     label: "Ring Decay",   min: 0.97, max: 0.999,step: 0.001,default: 0.992,unit: "",
      apply: (s, v) => (s._decay = v) },
    { id: "tail",      label: "Ring Tail",    min: 0.2,  max: 3,    step: 0.1,  default: 1.2, unit: "s",
      apply: (s, v) => (s._tail = v) },
  ],
  creek: [
    { id: "flowSpeed", label: "Flow Motion",  min: 0.4,  max: 2.5,  step: 0.05, default: 1,    unit: "×",
      apply: (s, v) => (s._rwSpeed = v) },
  ],
  fire: [
    { id: "crackleTone", label: "Crackle Tone", min: 1200, max: 5500, step: 50, default: 3500, unit: "Hz",
      apply: (s, v) => s._lp && (s._lp.frequency.value = v) },
    { id: "popRate",     label: "Pop Rate",     min: 0.3,  max: 3,    step: 0.05, default: 1,  unit: "×",
      apply: (s, v) => (s._popRateScale = v) },
  ],
  swamp: [
    { id: "rootPitch", label: "Root Pitch",   min: 30,   max: 120,  step: 1,    default: 55,  unit: "Hz",
      apply: (s, v) => s._oscs && s._oscs.filter(o=>o.frequency).forEach((o,i) => {
        const ratios=[1,1.005,2,3,1.5]; o.frequency.value = v*(ratios[i]||1); }) },
    { id: "wobbleRate",label: "Wobble Rate",  min: 0.01, max: 0.2,  step: 0.005,default: 0.04,unit: "Hz",
      apply: (s, v) => s._lfos && s._lfos.forEach((l,i) => l.frequency && (l.frequency.value = v+i*0.01)) },
    { id: "noiseLp",   label: "Mud Cutoff",   min: 40,   max: 600,  step: 10,   default: 180, unit: "Hz",
      apply: (s, v) => s._noiseLp && (s._noiseLp.frequency.value = v) },
  ],
  owl: [
    { id: "intervalMult", label: "Call Interval", min: 0.25, max: 4, step: 0.1, default: 1, unit: "×",
      apply: (s, v) => (s._intervalMult = v) },
    { id: "pitchBase",    label: "Hoot Pitch",    min: 180,  max: 420, step: 5, default: 280, unit: "Hz",
      apply: (s, v) => (s._pitchBase = v) },
  ],
  wolves: [
    { id: "intervalMult", label: "Howl Interval", min: 0.25, max: 4, step: 0.1, default: 1, unit: "×",
      apply: (s, v) => (s._intervalMult = v) },
    { id: "pitchBase",    label: "Pack Pitch",    min: 140,  max: 320, step: 5, default: 220, unit: "Hz",
      apply: (s, v) => (s._pitchBase = v) },
  ],
  heron: [
    { id: "intervalMult",label: "Call Interval",min: 0.2,max: 4,   step: 0.1,  default: 1,   unit: "×",
      apply: (s, v) => (s._intervalMult = v) },
    { id: "pitchBase", label: "Squawk Pitch",  min: 100, max: 600,  step: 10,   default: 280, unit: "Hz",
      apply: (s, v) => (s._pitchBase = v) },
    { id: "numSquawks",label: "Squawks",       min: 1,   max: 6,    step: 1,    default: 3,   unit: "",
      apply: (s, v) => (s._numSquawks = Math.round(v)) },
  ],
  gator: [
    { id: "intervalMult",label: "Bellow Interval",min: 0.2,max: 4, step: 0.1,  default: 1,   unit: "×",
      apply: (s, v) => (s._intervalMult = v) },
    { id: "subFreq",   label: "Infra Pitch",   min: 10,  max: 60,   step: 1,    default: 22,  unit: "Hz",
      apply: (s, v) => (s._subFreq = v) },
    { id: "dur",       label: "Bellow Length", min: 1,   max: 10,   step: 0.5,  default: 4,   unit: "s",
      apply: (s, v) => (s._dur = v) },
  ],
};

const LAYERS = [
  { id: "rain",      label: "Rain",       icon: "🌧️",  color: "#4a9eff", category: "weather" },
  { id: "waterfall", label: "Waterfall",  icon: "💧",  color: "#00c8ff", category: "weather" },
  { id: "wind",      label: "Wind",       icon: "🌬️",  color: "#a0c4ff", category: "weather" },
  { id: "thunder",   label: "Thunder",    icon: "⚡",   color: "#ffe066", category: "weather" },
  { id: "surf",      label: "Ocean Surf", icon: "🌊",  color: "#5ed6ff", category: "weather" },
  { id: "birds",     label: "Birds",      icon: "🐦",  color: "#7dde92", category: "nature"  },
  { id: "bees",      label: "Bees",       icon: "🐝",  color: "#ffd700", category: "nature"  },
  { id: "crickets",  label: "Crickets",   icon: "🦗",  color: "#98e08a", category: "nature"  },
  { id: "cicadas",   label: "Cicadas",    icon: "🪲",  color: "#e9ff7a", category: "nature"  },
  { id: "frogs",     label: "Frogs",      icon: "🐸",  color: "#4ecb71", category: "nature"  },
  { id: "drips",     label: "Drops",      icon: "💦",  color: "#63d0f5", category: "nature"  },
  { id: "creek",     label: "Creek",      icon: "🏞️",  color: "#78d9ff", category: "nature"  },
  { id: "fire",      label: "Campfire",   icon: "🔥",  color: "#ff9a4a", category: "nature"  },
  { id: "wolves",    label: "Wolves",     icon: "🐺",  color: "#c9d6e3", category: "nature"  },
  { id: "swamp",     label: "Swamp Drone",icon: "🌿",  color: "#6bcf8a", category: "everglades" },
  { id: "owl",       label: "Owls",       icon: "🦉",  color: "#d8c8a8", category: "everglades" },
  { id: "mosquitoes",label: "Mosquitoes", icon: "🦟",  color: "#e5ff9a", category: "everglades" },
  { id: "heron",     label: "Heron",      icon: "🦢",  color: "#c8e6c9", category: "everglades" },
  { id: "gator",     label: "Gator Rumble",icon: "🐊", color: "#8bc34a", category: "everglades" },
];

// ─────────────────────────────────────────────
//  REACT APP
// ─────────────────────────────────────────────

const MIDI_BINDINGS_STORAGE_KEY = "ambigram-midi-bindings-v1";
const OSC_URL_STORAGE_KEY = "ambigram-osc-url-v1";

function loadStoredJSON(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function loadStoredString(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch (_) {
    return fallback;
  }
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
}

function normalizeMidiBinding(binding) {
  if (!binding || typeof binding !== "object") return null;

  const channel = Number(binding.channel);
  const normalizedChannel =
    Number.isInteger(channel) && channel >= 1 && channel <= 16 ? channel : null;

  if (binding.type === "cc") {
    const controller = Number(binding.controller);
    if (!Number.isInteger(controller) || controller < 0 || controller > 127) return null;
    return { type: "cc", controller, channel: normalizedChannel };
  }

  if (binding.type === "noteon") {
    const note = Number(binding.note);
    if (!Number.isInteger(note) || note < 0 || note > 127) return null;
    return { type: "noteon", note, channel: normalizedChannel };
  }

  return null;
}

function loadMidiBindings() {
  const raw = loadStoredJSON(MIDI_BINDINGS_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object") return {};

  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, binding]) => {
        const normalized = normalizeMidiBinding(binding);
        return normalized ? [key, normalized] : null;
      })
      .filter(Boolean)
  );
}

function midiEventToBinding(event) {
  if (event?.type === "cc") {
    return normalizeMidiBinding({
      type: "cc",
      controller: event.controller,
      channel: event.channel,
    });
  }

  if (event?.type === "noteon") {
    return normalizeMidiBinding({
      type: "noteon",
      note: event.note,
      channel: event.channel,
    });
  }

  return null;
}

function midiBindingMatches(binding, event) {
  if (!binding || !event || binding.type !== event.type) return false;
  if (binding.channel && binding.channel !== event.channel) return false;
  if (binding.type === "cc") return binding.controller === event.controller;
  if (binding.type === "noteon") return binding.note === event.note;
  return false;
}

function describeMidiBinding(binding) {
  if (!binding) return "Not mapped";
  const channel = binding.channel ? ` ch${binding.channel}` : " any ch";
  if (binding.type === "cc") return `CC ${binding.controller}${channel}`;
  return `Note ${binding.note}${channel}`;
}

function formatMidiEvent(event) {
  if (!event) return "Waiting for MIDI data.";
  const channel = `ch${event.channel}`;
  if (event.type === "cc") return `Last: CC ${event.controller} ${channel} = ${event.value}`;
  if (event.type === "noteon") return `Last: Note ${event.note} ${channel} vel ${event.value}`;
  return `Last: Note ${event.note} ${channel} off`;
}

function legacyMidiBindingLabel(key) {
  if (key === "masterVol") return "Default: CC 1 or 7";
  if (key === "reverbMix") return "Default: CC 11";
  if (key === "thunderStrike") return "Default: CC 64";
  if (key.startsWith("layer:")) {
    const id = key.slice(6);
    const index = LAYER_ORDER.indexOf(id);
    if (index >= 0) return `Default: CC ${20 + index}`;
  }
  return "No default";
}

function getOscArgValue(value) {
  if (Array.isArray(value)) return getOscArgValue(value[0]);
  if (value && typeof value === "object") {
    if ("value" in value) return getOscArgValue(value.value);
    if ("data" in value) return getOscArgValue(value.data);
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

function getFirstOscArg(args) {
  if (!Array.isArray(args) || args.length === 0) return undefined;
  return getOscArgValue(args[0]);
}

function parseOscToggleMode(value) {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (["1", "on", "true"].includes(lowered)) return "on";
    if (["0", "off", "false"].includes(lowered)) return "off";
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num >= 0.5 ? "on" : "off";
}

// ─────────────────────────────────────────────
//  MIDI CONTROLLER — Web MIDI API
//  CC assignments (all channels, remappable):
//    CC 1  (Mod Wheel) → Master Volume
//    CC 7  (Volume)    → Master Volume
//    CC 11 (Expression)→ Reverb Mix
//    CC 20 upward      → Layer levels in LAYER_ORDER sequence
//    CC 64 (Sustain)   → Thunder strike (gate high → trigger)
//    CC 70 upward      → First param of each layer (fine-tune live)
//    Note On from C3   → Layer on/off toggle in LAYER_ORDER sequence
// ─────────────────────────────────────────────

const LAYER_ORDER = ["rain","waterfall","wind","thunder","surf","birds","bees",
                     "crickets","cicadas","frogs","drips","creek","fire","wolves",
                     "swamp","owl","mosquitoes","heron","gator"];

const MIDI_LEARN_TARGETS = [
  { key: "masterVol", label: "Master Volume" },
  { key: "reverbMix", label: "Reverb Mix" },
  { key: "thunderStrike", label: "Thunder Strike" },
  ...LAYER_ORDER.map(id => ({
    key: `layer:${id}`,
    label: `${LAYERS.find(layer => layer.id === id)?.label || id} Level`,
  })),
];

class MIDIController {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.access = null;
    this.enabled = false;
    this._onInputsChange = null;
  }

  async init() {
    if (this.access) {
      this._attachInputs();
      this.enabled = true;
      return true;
    }
    if (!navigator.requestMIDIAccess) {
      console.warn("Web MIDI API not available in this browser.");
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this._attachInputs();
      this.access.onstatechange = () => this._attachInputs();
      this.enabled = true;
      return true;
    } catch (e) {
      console.warn("MIDI access denied:", e);
      return false;
    }
  }

  _attachInputs() {
    const names = [];
    this.access.inputs.forEach(input => {
      input.onmidimessage = (msg) => this._handle(msg.data);
      names.push(input.name || "Unnamed MIDI Input");
    });
    this._onInputsChange && this._onInputsChange(names);
  }

  _handle(data) {
    const [status, d1 = 0, d2 = 0] = data;
    const type = status & 0xF0;
    const channel = (status & 0x0F) + 1;

    if (type === 0xB0) {
      this.onMessage?.({
        type: "cc",
        channel,
        controller: d1,
        value: d2,
        value01: d2 / 127,
      });
      return;
    }

    if (type === 0x90) {
      this.onMessage?.({
        type: d2 > 0 ? "noteon" : "noteoff",
        channel,
        note: d1,
        value: d2,
        value01: d2 / 127,
      });
      return;
    }

    if (type === 0x80) {
      this.onMessage?.({
        type: "noteoff",
        channel,
        note: d1,
        value: d2,
        value01: d2 / 127,
      });
    }
  }

  inputNames() {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values()).map(i => i.name);
  }

  destroy() {
    if (this.access) {
      this.access.onstatechange = null;
      this.access.inputs.forEach(i => (i.onmidimessage = null));
    }
    this.enabled = false;
  }
}

// ─────────────────────────────────────────────
//  OSC CONTROLLER — WebSocket bridge
//  Expects a local bridge server (e.g. osc-web-bridge or node-osc)
//  listening on ws://localhost:8080 that forwards UDP OSC packets.
//
//  Supported OSC addresses:
//    /ambigram/master/volume  f  0.0–1.0
//    /ambigram/master/reverb  f  0.0–1.0
//    /ambigram/layer/<id>     f  0.0–1.0   (level)
//    /ambigram/layer/<id>/on  i  1=on 0=off
//    /ambigram/param/<id>/<paramId> f
//    /ambigram/thunder/strike i  (any value → trigger)
// ─────────────────────────────────────────────

class OSCController {
  constructor(onCC, onLayerToggle, onThunder, onParam, wsUrl = "ws://localhost:8080") {
    this.onCC          = onCC;
    this.onLayerToggle = onLayerToggle;
    this.onThunder     = onThunder;
    this.onParam       = onParam;
    this.wsUrl         = wsUrl;
    this.ws            = null;
    this.enabled       = false;
    this.status        = "disconnected"; // "disconnected" | "connecting" | "connected" | "error"
    this._onStatus     = null;
  }

  connect(wsUrl = this.wsUrl) {
    this.wsUrl  = wsUrl;
    this.status = "connecting";
    this._onStatus && this._onStatus(this.status);

    if (this.ws) this.disconnect();

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      this.status = "error";
      this._onStatus && this._onStatus(this.status);
      return;
    }

    this.ws.onopen = () => {
      this.status  = "connected";
      this.enabled = true;
      this._onStatus && this._onStatus(this.status);
    };

    this.ws.onclose = () => {
      this.status  = "disconnected";
      this.enabled = false;
      this._onStatus && this._onStatus(this.status);
    };

    this.ws.onerror = () => {
      this.status  = "error";
      this.enabled = false;
      this._onStatus && this._onStatus(this.status);
    };

    this.ws.onmessage = (e) => {
      try {
        // Bridge sends JSON: { address: "/ambigram/...", args: [...] }
        const { address, args } = JSON.parse(e.data);
        this._dispatch(address, args);
      } catch (_) {}
    };
  }

  _dispatch(addr, args) {
    const parts = addr.split("/").filter(Boolean); // ["ambigram", ...]
    const firstArg = getFirstOscArg(args);
    if (parts[0] !== "ambigram") return;

    if (parts[1] === "master") {
      const value = clamp01(firstArg);
      if (value == null) return;
      if (parts[2] === "volume" || parts[2] === "vol") return this.onCC("masterVol", value);
      if (parts[2] === "reverb") return this.onCC("reverbMix", value);
    }

    if (parts[1] === "layer") {
      const id = parts[2];
      if (!id) return;
      if (parts[3] === "on") {
        const mode = parseOscToggleMode(firstArg);
        if (mode) return this.onLayerToggle(id, mode);
        return;
      }
      const value = clamp01(firstArg);
      if (value != null) return this.onCC(`layer:${id}`, value);
      return;
    }

    if (parts[1] === "param") {
      const [,, layerId, paramId] = parts;
      const value = Number(firstArg);
      if (layerId && paramId && Number.isFinite(value))
        return this.onParam(layerId, paramId, value);
    }

    if (parts[1] === "thunder" && parts[2] === "strike") {
      this.onThunder();
    }
  }

  disconnect() {
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.enabled = false;
  }
}

// ─────────────────────────────────────────────
//  EVOLUTION ENGINE — slow stochastic drift
//  Each active layer's params wander within their allowed range
//  using band-limited random walks (Ornstein-Uhlenbeck process).
//  Period: full cycle in ~60–180 seconds. Completely imperceptible
//  moment-to-moment but means the soundscape never sounds the same twice.
// ─────────────────────────────────────────────

class EvolutionEngine {
  constructor() {
    this._timer  = null;
    this._active = false;
    this._phase  = {}; // layerId → { paramId → phase(0-1) }
    this._speed  = {}; // layerId → { paramId → drift speed }
    this.onUpdate = null; // (layerId, paramId, newVal) => void
    this.tickMs   = 500; // update every 500ms
    this.strength = 0.25; // how far from default params can drift (0–1 of range)
  }

  start(layerParams) {
    if (this._active) return;
    this._active = true;
    // Initialise random phases and speeds for each param
    Object.entries(layerParams).forEach(([lid, params]) => {
      this._phase[lid] = {};
      this._speed[lid] = {};
      params.forEach(p => {
        this._phase[lid][p.id] = Math.random(); // random starting phase
        // Random drift speed: completes ~0.3-1 full cycle per minute
        this._speed[lid][p.id] = (0.005 + Math.random() * 0.012) * (Math.random() < 0.5 ? 1 : -1);
      });
    });
    this._tick(layerParams);
  }

  stop() {
    this._active = false;
    clearTimeout(this._timer);
  }

  setStrength(v) { this.strength = Math.max(0, Math.min(1, v)); }

  _tick(layerParams) {
    if (!this._active) return;

    Object.entries(layerParams).forEach(([lid, params]) => {
      if (!this._phase[lid]) return;
      params.forEach(p => {
        // Advance phase
        this._phase[lid][p.id] += this._speed[lid][p.id];
        // Reflect at boundaries (ping-pong oscillation)
        if (this._phase[lid][p.id] > 1) {
          this._phase[lid][p.id] = 2 - this._phase[lid][p.id];
          this._speed[lid][p.id] *= -1;
        }
        if (this._phase[lid][p.id] < 0) {
          this._phase[lid][p.id] = -this._phase[lid][p.id];
          this._speed[lid][p.id] *= -1;
        }

        // Map phase → value: wander within strength% of the full range
        const mid   = (p.max + p.min) / 2;
        const half  = (p.max - p.min) / 2 * this.strength;
        const val   = mid + (this._phase[lid][p.id] * 2 - 1) * half;
        const snapped = Math.round(val / p.step) * p.step;
        const clamped = Math.max(p.min, Math.min(p.max, snapped));

        if (this.onUpdate) this.onUpdate(lid, p.id, clamped);
      });
    });

    this._timer = setTimeout(() => this._tick(layerParams), this.tickMs);
  }
}

const evolutionEngine = new EvolutionEngine();

const SAMPLE_RATES = [44100, 48000, 88200, 96000, 192000];
const BIT_DEPTHS   = [16, 24, 32];

const engine = new AmbigramEngine();

// ─────────────────────────────────────────────
//  VerticalFader — cross-browser custom drag slider
//  Works identically in Chrome, Firefox, Safari, and on touch.
//  value: 0–1  onChange: (newValue) => void
// ─────────────────────────────────────────────
function VerticalFader({ value, onChange, color, height = 80 }) {
  const trackRef = useRef(null);
  const dragging = useRef(false);

  const valueFromY = (clientY) => {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
  };

  const onMouseDown = (e) => {
    e.preventDefault();
    dragging.current = true;
    onChange(valueFromY(e.clientY));
    const move = (e) => { if (dragging.current) onChange(valueFromY(e.clientY)); };
    const up   = ()  => { dragging.current = false; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onTouchStart = (e) => {
    e.preventDefault();
    onChange(valueFromY(e.touches[0].clientY));
    const move = (e) => onChange(valueFromY(e.touches[0].clientY));
    const end  = ()  => { window.removeEventListener("touchmove", move); window.removeEventListener("touchend", end); };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  const pct = `${value * 100}%`;
  return (
    <div ref={trackRef}
      style={{ width: 22, height, position: "relative", cursor: "ns-resize", flexShrink: 0, userSelect: "none" }}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}>
      {/* Track groove */}
      <div style={{
        position: "absolute", left: "50%", transform: "translateX(-50%)",
        width: 4, height: "100%", background: "#1a2a1c", borderRadius: 2,
      }} />
      {/* Filled portion (bottom to thumb) */}
      <div style={{
        position: "absolute", left: "50%", transform: "translateX(-50%)",
        width: 4, bottom: 0, height: pct,
        background: color + "88", borderRadius: 2,
        transition: "height 0.05s linear",
      }} />
      {/* Thumb */}
      <div style={{
        position: "absolute", left: "50%", transform: "translateX(-50%)",
        width: 16, height: 7,
        bottom: `calc(${pct} - 3px)`,
        background: color, borderRadius: 3,
        boxShadow: `0 0 6px ${color}88`,
        transition: "bottom 0.05s linear",
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SurroundPositioner — top-down room SVG with draggable source dot
//
//  Drag the coloured dot to place a sound layer anywhere in the soundfield.
//  Speaker icons are drawn at their true azimuth positions.
//  0° = front-centre. Clockwise = positive (standard audio convention).
// ─────────────────────────────────────────────────────────────────────────────
function SurroundPositioner({ azimuth, onChange, color, format, size = 80 }) {
  const svgRef  = useRef(null);
  const dragging = useRef(false);

  const R   = size / 2;               // room radius in SVG units
  const cx  = size / 2;
  const cy  = size / 2;
  const sr  = size * 0.36;            // speaker ring radius
  const dot = Math.max(5, size * 0.1); // source dot radius

  // Convert azimuth (degrees, 0=front, CW) to SVG x/y
  const azToXY = (az, r) => ({
    x: cx + r * Math.sin((az * Math.PI) / 180),
    y: cy - r * Math.cos((az * Math.PI) / 180),
  });

  const xyToAz = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    const dx   = clientX - (rect.left + rect.width  / 2);
    const dy   = clientY - (rect.top  + rect.height / 2);
    return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  };

  const onMouseDown = (e) => {
    e.preventDefault(); dragging.current = true;
    onChange(xyToAz(e.clientX, e.clientY));
    const move = (e) => { if (dragging.current) onChange(xyToAz(e.clientX, e.clientY)); };
    const up   = ()  => { dragging.current = false; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onTouchStart = (e) => {
    e.preventDefault();
    onChange(xyToAz(e.touches[0].clientX, e.touches[0].clientY));
    const move = (e) => onChange(xyToAz(e.touches[0].clientX, e.touches[0].clientY));
    const end  = ()  => { window.removeEventListener("touchmove", move); window.removeEventListener("touchend", end); };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  const srcPos = azToXY(azimuth, sr * 0.6);
  const azDisplay = azimuth < 0 ? azimuth + 360 : azimuth;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <svg ref={svgRef} width={size} height={size}
        style={{ cursor: "crosshair", userSelect: "none", display: "block" }}
        onMouseDown={onMouseDown} onTouchStart={onTouchStart}>

        {/* Room boundary */}
        <circle cx={cx} cy={cy} r={R - 2} fill="none" stroke="#1a2e1c" strokeWidth={1.5} />
        {/* Front indicator tick */}
        <line x1={cx} y1={2} x2={cx} y2={cy * 0.32} stroke="#2a4a34" strokeWidth={1} />

        {/* Speaker positions */}
        {format.speakers.filter(s => !s.lfe).map((sp, i) => {
          const speakerRadius = sr * (1 - ((sp.el ?? 0) / 90) * 0.35);
          const { x, y } = azToXY(sp.az, speakerRadius);
          return (
            <g key={i}>
              <circle
                cx={x}
                cy={y}
                r={(sp.el ?? 0) > 0 ? 3.4 : 4}
                fill={(sp.el ?? 0) > 0 ? "#1d2f3f" : "#1a3a22"}
                stroke={(sp.el ?? 0) > 0 ? "#72b8ff" : "#3a6a44"}
                strokeWidth={1}
              />
              <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle"
                fill={(sp.el ?? 0) > 0 ? "#8dc5ff" : "#3a6a44"}
                fontSize={Math.max(5, size * 0.07)} fontFamily="monospace">
                {sp.name}
              </text>
            </g>
          );
        })}

        {/* Listener position */}
        <circle cx={cx} cy={cy} r={3} fill="#1a3a22" stroke="#4a7a54" strokeWidth={1} />

        {/* Line from listener to source */}
        <line x1={cx} y1={cy} x2={srcPos.x} y2={srcPos.y}
          stroke={color + "55"} strokeWidth={1} strokeDasharray="3 2" />

        {/* Source dot — draggable */}
        <circle cx={srcPos.x} cy={srcPos.y} r={dot}
          fill={color + "cc"} stroke={color} strokeWidth={1.5}
          style={{ filter: `drop-shadow(0 0 ${size * 0.05}px ${color})` }} />
      </svg>
      <span style={{ fontSize: 8, color: "#4a7a54", fontFamily: "monospace", letterSpacing: 1 }}>
        {Math.round(azDisplay)}°
      </span>
    </div>
  );
}

export default function Ambigram() {
  const [started, setStarted] = useState(false);
  const [masterVol, setMasterVol] = useState(0.85);
  const [reverbMix, setReverbMix] = useState(0.22);
  const [activePreset, setActivePreset] = useState(null);
  const [thunderAuto, setThunderAuto] = useState(false);
  const [sampleRate, setSampleRate]   = useState(96000);
  const [bitDepth, setBitDepth]       = useState(32);
  const [actualRate, setActualRate]   = useState(null);
  const [recording, setRecording]     = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const recorderRef  = useRef(null);
  const recTimerRef  = useRef(null);

  // Surround format + per-layer azimuth positions
  const [surroundKey, setSurroundKey] = useState("stereo");
  const [layerAzimuths, setLayerAzimuths] = useState(() =>
    Object.fromEntries(Object.entries(LAYER_DEFAULT_AZ).map(([k, v]) => [k, v]))
  );
  const setSurroundAz = useCallback((layerId, az) => {
    setLayerAzimuths(prev => ({ ...prev, [layerId]: az }));
    engine.setSurroundAz(layerId, az);
  }, []);

  // layerState: { id → { active: bool, level: number } }
  const [layerState, setLayerState] = useState(() =>
    Object.fromEntries(LAYERS.map(l => [l.id, { active: false, level: 0.5 }]))
  );

  // expandedCards: set of layer ids with param panel open
  const [expandedCards, setExpandedCards] = useState(new Set());

  // paramState: { layerId → { paramId → number } }
  const [paramState, setParamState] = useState(() =>
    Object.fromEntries(
      Object.entries(LAYER_PARAMS).map(([lid, params]) => [
        lid,
        Object.fromEntries(params.map(p => [p.id, p.default]))
      ])
    )
  );

  const toggleExpand = useCallback((id) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const setParam = useCallback((layerId, paramId, value) => {
    setParamState(prev => ({
      ...prev,
      [layerId]: { ...prev[layerId], [paramId]: value }
    }));
    const synth = engine.synths[layerId];
    const paramDef = LAYER_PARAMS[layerId]?.find(p => p.id === paramId);
    if (synth && paramDef?.apply) {
      try { paramDef.apply(synth, value); } catch(_) {}
    }
  }, []);

  const triggerThunder = useCallback(() => {
    if (!started || !engine.synths.thunder) return;
    engine.synths.thunder.trigger();
  }, [started]);

  const setLayerLevel = useCallback((id, val) => {
    if (!started) return;
    const synth = engine.synths[id];
    if (synth && synth.setLevel) synth.setLevel(val);
    setLayerState(prev => ({ ...prev, [id]: { ...prev[id], level: val } }));
  }, [started]);

  const toggleLayer = useCallback((id) => {
    if (!started) return;
    setLayerState(prev => {
      const cur = prev[id];
      const synth = engine.synths[id];
      if (!synth) return prev;

      if (id === "thunder") {
        if (!cur.active) {
          synth.trigger();
          // trigger doesn't stay "active" — it's a one-shot
          return prev;
        }
        return prev;
      }

      if (cur.active) {
        synth.stop();
      } else {
        synth.start();
      }
      return { ...prev, [id]: { ...cur, active: !cur.active } };
    });
  }, [started]);

  // ── MIDI / OSC ──────────────────────────────
  const midiRef   = useRef(null);
  const oscRef    = useRef(null);
  const midiGateStateRef = useRef({});
  const [midiEnabled,  setMidiEnabled]  = useState(false);
  const [midiInputs,   setMidiInputs]   = useState([]);
  const [midiBindings, setMidiBindings] = useState(() => loadMidiBindings());
  const [midiLearnTarget, setMidiLearnTarget] = useState(null);
  const [midiLearnStatus, setMidiLearnStatus] = useState("Custom mappings override the defaults below.");
  const [midiLastMessage, setMidiLastMessage] = useState("Waiting for MIDI data.");
  const [oscStatus,    setOscStatus]    = useState("disconnected");
  const [oscUrl,       setOscUrl]       = useState(() => loadStoredString(OSC_URL_STORAGE_KEY, "ws://localhost:8080"));
  const [showControl,  setShowControl]  = useState(false);

  // Unified CC handler — called by both MIDI and OSC
  const handleCC = useCallback((key, val) => {
    if (key === "masterVol") { setMasterVol(val); return; }
    if (key === "reverbMix") { setReverbMix(val); return; }
    if (key.startsWith("layer:")) {
      const id = key.slice(6);
      setLayerLevel(id, val);
      return;
    }
    if (key.startsWith("param:")) {
      const [,layerId, paramId] = key.split(":");
      const paramDef = LAYER_PARAMS[layerId]?.find(p => p.id === paramId);
      if (paramDef) {
        const scaled = paramDef.min + val * (paramDef.max - paramDef.min);
        setParam(layerId, paramId, scaled);
      }
      return;
    }
    if (key.startsWith("param0:")) {
      const id = key.slice(7);
      const params = LAYER_PARAMS[id];
      if (params?.[0]) {
        const p = params[0];
        setParam(id, p.id, p.min + val * (p.max - p.min));
      }
    }
  }, [setLayerLevel, setParam]);

  const handleOscParam = useCallback((layerId, paramId, value) => {
    const paramDef = LAYER_PARAMS[layerId]?.find(p => p.id === paramId);
    if (!paramDef) return;
    const clamped = Math.max(paramDef.min, Math.min(paramDef.max, value));
    setParam(layerId, paramId, clamped);
  }, [setParam]);

  const handleLayerToggleExternal = useCallback((id, mode) => {
    const state = engine.synths[id];
    if (!state) return;
    if (mode === "on"  && !state.active) toggleLayer(id);
    if (mode === "off" && state.active)  toggleLayer(id);
    if (!mode) toggleLayer(id); // bare toggle (MIDI note)
  }, [toggleLayer]);

  const applyLegacyMidiMapping = useCallback((event) => {
    if (event.type === "cc") {
      if (event.controller === 1 || event.controller === 7) return handleCC("masterVol", event.value01);
      if (event.controller === 11) return handleCC("reverbMix", event.value01);
      if (event.controller >= 20 && event.controller < 20 + LAYER_ORDER.length) {
        return handleCC(`layer:${LAYER_ORDER[event.controller - 20]}`, event.value01);
      }
      if (event.controller >= 70 && event.controller < 70 + LAYER_ORDER.length) {
        return handleCC(`param0:${LAYER_ORDER[event.controller - 70]}`, event.value01);
      }
      if (event.controller === 64) {
        const isHigh = event.value >= 64;
        const wasHigh = !!midiGateStateRef.current.legacyThunder;
        midiGateStateRef.current.legacyThunder = isHigh;
        if (isHigh && !wasHigh) triggerThunder();
      }
      return;
    }

    if (event.type === "noteon" && event.note >= 48 && event.note < 48 + LAYER_ORDER.length) {
      handleLayerToggleExternal(LAYER_ORDER[event.note - 48]);
    }
  }, [handleCC, handleLayerToggleExternal, triggerThunder]);

  const applyMidiAction = useCallback((actionKey, event) => {
    if (event.type === "noteoff") return;

    if (actionKey === "masterVol") {
      handleCC("masterVol", event.type === "cc" ? event.value01 : 1);
      return;
    }

    if (actionKey === "reverbMix") {
      handleCC("reverbMix", event.type === "cc" ? event.value01 : 1);
      return;
    }

    if (actionKey === "thunderStrike") {
      if (event.type === "cc") {
        const isHigh = event.value >= 64;
        const wasHigh = !!midiGateStateRef.current[actionKey];
        midiGateStateRef.current[actionKey] = isHigh;
        if (isHigh && !wasHigh) triggerThunder();
        return;
      }
      triggerThunder();
      return;
    }

    if (actionKey.startsWith("layer:")) {
      handleCC(actionKey, event.type === "cc" ? event.value01 : 1);
    }
  }, [handleCC, triggerThunder]);

  const handleMidiMessage = useCallback((event) => {
    setMidiLastMessage(formatMidiEvent(event));

    if (midiLearnTarget) {
      const learnedBinding = midiEventToBinding(event);
      if (learnedBinding) {
        setMidiBindings(prev => ({ ...prev, [midiLearnTarget]: learnedBinding }));
        const target = MIDI_LEARN_TARGETS.find(item => item.key === midiLearnTarget);
        setMidiLearnStatus(`${target?.label || midiLearnTarget} learned as ${describeMidiBinding(learnedBinding)}.`);
        setMidiLearnTarget(null);
      }
      return;
    }

    const customAction = Object.entries(midiBindings).find(([, binding]) =>
      midiBindingMatches(binding, event)
    );

    if (customAction) {
      applyMidiAction(customAction[0], event);
      return;
    }

    applyLegacyMidiMapping(event);
  }, [applyLegacyMidiMapping, applyMidiAction, midiBindings, midiLearnTarget]);

  const initMIDI = useCallback(async () => {
    if (!midiRef.current) {
      midiRef.current = new MIDIController(handleMidiMessage);
    }
    midiRef.current.onMessage = handleMidiMessage;
    midiRef.current._onInputsChange = setMidiInputs;
    const ok = await midiRef.current.init();
    if (ok) {
      setMidiEnabled(true);
      setMidiInputs(midiRef.current.inputNames());
      setMidiLearnStatus("MIDI ready. Use Learn on any control to map your fader box.");
    }
    return ok;
  }, [handleMidiMessage]);

  const connectOSC = useCallback(() => {
    if (!oscRef.current) {
      oscRef.current = new OSCController(
        handleCC,
        handleLayerToggleExternal,
        triggerThunder,
        handleOscParam,
        oscUrl
      );
    }
    oscRef.current.onCC = handleCC;
    oscRef.current.onLayerToggle = handleLayerToggleExternal;
    oscRef.current.onThunder = triggerThunder;
    oscRef.current.onParam = handleOscParam;
    oscRef.current._onStatus = setOscStatus;
    oscRef.current.connect(oscUrl);
  }, [handleCC, handleLayerToggleExternal, handleOscParam, triggerThunder, oscUrl]);

  const disconnectOSC = useCallback(() => {
    oscRef.current?.disconnect();
  }, []);

  const beginMidiLearn = useCallback(async (targetKey) => {
    if (!midiEnabled) {
      const ok = await initMIDI();
      if (!ok) {
        setMidiLearnStatus("MIDI could not be enabled in this browser.");
        return;
      }
    }
    const target = MIDI_LEARN_TARGETS.find(item => item.key === targetKey);
    setMidiLearnTarget(targetKey);
    setMidiLearnStatus(`Move a control now for ${target?.label || targetKey}.`);
  }, [initMIDI, midiEnabled]);

  const clearMidiBinding = useCallback((targetKey) => {
    setMidiBindings(prev => {
      const next = { ...prev };
      delete next[targetKey];
      return next;
    });
    if (midiLearnTarget === targetKey) setMidiLearnTarget(null);
    setMidiLearnStatus(`${MIDI_LEARN_TARGETS.find(item => item.key === targetKey)?.label || targetKey} reset to its default mapping.`);
  }, [midiLearnTarget]);

  const resetMidiBindings = useCallback(() => {
    setMidiBindings({});
    setMidiLearnTarget(null);
    setMidiLearnStatus("Custom MIDI mappings cleared. Legacy defaults are active again.");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MIDI_BINDINGS_STORAGE_KEY, JSON.stringify(midiBindings));
  }, [midiBindings]);

  useEffect(() => {
    if (!midiRef.current) return;
    midiRef.current.onMessage = handleMidiMessage;
    midiRef.current._onInputsChange = setMidiInputs;
  }, [handleMidiMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OSC_URL_STORAGE_KEY, oscUrl);
  }, [oscUrl]);

  useEffect(() => {
    if (!oscRef.current) return;
    oscRef.current.onCC = handleCC;
    oscRef.current.onLayerToggle = handleLayerToggleExternal;
    oscRef.current.onThunder = triggerThunder;
    oscRef.current.onParam = handleOscParam;
    oscRef.current._onStatus = setOscStatus;
  }, [handleCC, handleLayerToggleExternal, handleOscParam, triggerThunder]);

  // ── EVOLUTION ───────────────────────────────
  const [evolveOn,       setEvolveOn]       = useState(false);
  const [evolveStrength, setEvolveStrength] = useState(0.25);

  const toggleEvolve = useCallback(() => {
    setEvolveOn(prev => {
      const next = !prev;
      if (next) {
        evolutionEngine.setStrength(evolveStrength);
        evolutionEngine.onUpdate = (lid, pid, val) => {
          // Only evolve active layers
          const synth = engine.synths[lid];
          if (!synth?.active) return;
          const paramDef = LAYER_PARAMS[lid]?.find(p => p.id === pid);
          if (paramDef?.apply) { try { paramDef.apply(synth, val); } catch(_){} }
          setParamState(ps => ({ ...ps, [lid]: { ...ps[lid], [pid]: val } }));
        };
        evolutionEngine.start(LAYER_PARAMS);
      } else {
        evolutionEngine.stop();
      }
      return next;
    });
  }, [evolveStrength]);

  useEffect(() => {
    if (evolveOn) evolutionEngine.setStrength(evolveStrength);
  }, [evolveStrength, evolveOn]);

  // Cleanup on unmount
  useEffect(() => () => {
    evolutionEngine.stop();
    clearInterval(recTimerRef.current);
    recorderRef.current?.destroy();
    midiRef.current?.destroy();
    oscRef.current?.disconnect();
  }, []);

  const initAndStart = useCallback(async (sr = sampleRate, sk = surroundKey) => {
    await engine.init(sr, sk);
    setActualRate(engine.actualSampleRate);
    setStarted(true);
  }, [sampleRate, surroundKey]);

  // Shared teardown+reinit helper
  const restartEngine = useCallback(async (newRate, newKey) => {
    if (recorderRef.current) {
      recorderRef.current.destroy(); recorderRef.current = null;
      setRecording(false); clearInterval(recTimerRef.current);
    }
    await engine.teardown();
    setStarted(false);
    setLayerState(Object.fromEntries(LAYERS.map(l => [l.id, { active: false, level: 0.5 }])));
    setThunderAuto(false);
    await engine.init(newRate, newKey);
    setActualRate(engine.actualSampleRate);
    setStarted(true);
  }, []);

  // Reinitialize engine when sample rate changes after first start
  const changeSampleRate = useCallback(async (newRate) => {
    setSampleRate(newRate);
    if (!started) return;
    await restartEngine(newRate, surroundKey);
  }, [started, surroundKey, restartEngine]);

  // Reinitialize engine when surround format changes
  const changeSurroundFormat = useCallback(async (newKey) => {
    setSurroundKey(newKey);
    if (!started) return;
    await restartEngine(sampleRate, newKey);
  }, [started, sampleRate, restartEngine]);

  const startRecording = useCallback(() => {
    if (!started || recording) return;
    const nCh     = engine.surroundFormat?.channels ?? 2;
    const recorder = new RecorderNode(engine.ctx, engine.master, nCh);
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
    setRecDuration(0);
    recTimerRef.current = setInterval(() => setRecDuration(d => d + 1), 1000);
  }, [started, recording]);

  const stopRecording = useCallback(() => {
    if (!recorderRef.current) return;
    clearInterval(recTimerRef.current);
    const { channels, frames } = recorderRef.current.stop();
    recorderRef.current.destroy();
    recorderRef.current = null;
    setRecording(false);
    setRecDuration(0);

    if (frames === 0) return;
    const sr  = engine.actualSampleRate || engine.sampleRate;
    const nCh = channels.length;
    const wav = encodeWAV(channels, sr, bitDepth, engine.surroundFormat?.channelMask);
    const fmt = nCh > 2 ? `${nCh}ch-` : "";
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadWAV(wav, `ambigram-${ts}-${fmt}${sr}hz-${bitDepth}bit.wav`);
  }, [bitDepth]);

  // Master volume
  useEffect(() => {
    if (started) engine.setMasterVol(masterVol);
  }, [masterVol, started]);

  // Reverb mix
  useEffect(() => {
    if (started) engine.setReverb(reverbMix);
  }, [reverbMix, started]);

  const applyPreset = useCallback(async (name) => {
    if (!started) await initAndStart(sampleRate);
    const preset = PRESETS[name];
    if (!preset) return;
    setActivePreset(name);

    LAYERS.forEach(({ id }) => {
      const synth = engine.synths[id];
      if (!synth) return;
      const val = preset[id];

      if (id === "thunder") {
        const auto = !!preset.thunder;
        setThunderAuto(auto);
        synth.setAutoMode(auto);
        return;
      }

      const level = typeof val === "number" ? val : 0;
      const shouldBeActive = level > 0;

      setLayerState(prev => {
        const cur = prev[id];
        if (shouldBeActive && !cur.active) synth.start();
        if (!shouldBeActive && cur.active) synth.stop();
        synth.setLevel && synth.setLevel(level);
        return { ...prev, [id]: { active: shouldBeActive, level } };
      });
    });
  }, [initAndStart, sampleRate, started]);

  const stopAll = useCallback(() => {
    LAYERS.forEach(({ id }) => {
      const synth = engine.synths[id];
      if (!synth) return;
      if (id === "thunder") { synth.setAutoMode(false); return; }
      synth.stop && synth.stop();
    });
    setLayerState(prev =>
      Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, active: false }]))
    );
    setThunderAuto(false);
    setActivePreset(null);
  }, []);

  // Group layers by category
  const grouped = { weather: [], nature: [], everglades: [] };
  LAYERS.forEach(l => grouped[l.category].push(l));

  const categoryLabel = { weather: "🌦 Weather", nature: "🌲 Nature", everglades: "🌿 Everglades" };

  // ── RENDER ──────────────────────────────────

  if (!started) {
    return (
      <div style={styles.splash}>
        <div style={styles.splashInner}>
          <div style={styles.logo}>🌿</div>
          <h1 style={styles.title}>AMBIGRAM</h1>
          <p style={styles.subtitle}>AI-driven ambient generation<br/>Physical modeling · Analog synthesis</p>

          {/* Pre-launch audio format selectors */}
          <div style={styles.formatRow}>
            <div style={styles.formatGroup}>
              <label style={styles.formatLabel}>SAMPLE RATE</label>
              <select style={styles.select} value={sampleRate}
                onChange={e => setSampleRate(+e.target.value)}>
                {SAMPLE_RATES.map(r => (
                  <option key={r} value={r}>{(r/1000).toFixed(r % 1000 === 0 ? 0 : 1)} kHz</option>
                ))}
              </select>
            </div>
            <div style={styles.formatGroup}>
              <label style={styles.formatLabel}>BIT DEPTH</label>
              <select style={styles.select} value={bitDepth}
                onChange={e => setBitDepth(+e.target.value)}>
                {BIT_DEPTHS.map(b => (
                  <option key={b} value={b}>{b}-bit{b === 32 ? " float" : " PCM"}</option>
                ))}
              </select>
            </div>
            <div style={styles.formatGroup}>
              <label style={styles.formatLabel}>OUTPUT FORMAT</label>
              <select style={styles.select} value={surroundKey}
                onChange={e => setSurroundKey(e.target.value)}>
                {Object.values(SURROUND_FORMATS).map(f => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </div>
          </div>

          <button style={styles.startBtn} onClick={() => initAndStart(sampleRate, surroundKey)}>
            ▶ Begin Session
          </button>
          <p style={styles.hint}>Rain · Waterfall · Wind · Birds · Bees · Frogs · Everglades</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🌿</span>
          <span style={styles.titleSmall}>AMBIGRAM</span>
        </div>

        {/* Master controls */}
        <div style={styles.masterControls}>
          <label style={styles.label}>VOL</label>
          <input type="range" min={0} max={1} step={0.01} value={masterVol}
            style={styles.slider} onChange={e => setMasterVol(+e.target.value)} />
          <label style={{ ...styles.label, marginLeft: 12 }}>REVERB</label>
          <input type="range" min={0} max={1} step={0.01} value={reverbMix}
            style={styles.slider} onChange={e => setReverbMix(+e.target.value)} />

          {/* Format controls — live */}
          <div style={styles.divider} />
          <label style={styles.label}>SR</label>
          <select style={styles.selectSm} value={sampleRate}
            onChange={e => changeSampleRate(+e.target.value)}>
            {SAMPLE_RATES.map(r => (
              <option key={r} value={r}>{(r/1000).toFixed(r % 1000 === 0 ? 0 : 1)}k</option>
            ))}
          </select>
          {actualRate && actualRate !== sampleRate && (
            <span style={styles.rateWarn} title="Browser granted a different rate">
              ⚠ {(actualRate/1000).toFixed(1)}k
            </span>
          )}
          <label style={{ ...styles.label, marginLeft: 8 }}>BITS</label>
          <select style={styles.selectSm} value={bitDepth}
            onChange={e => setBitDepth(+e.target.value)}>
            {BIT_DEPTHS.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <label style={{ ...styles.label, marginLeft: 8 }}>OUT</label>
          <select style={styles.selectSm} value={surroundKey}
            onChange={e => changeSurroundFormat(e.target.value)}>
            {Object.values(SURROUND_FORMATS).map(f => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>

          <div style={styles.divider} />

          {/* Record button */}
          <button
            style={{
              ...styles.recBtn,
              background: recording ? "#ff304480" : "rgba(255,48,68,0.12)",
              borderColor: recording ? "#ff3044" : "#882233",
              color: recording ? "#ff8090" : "#884455",
            }}
            onClick={recording ? stopRecording : startRecording}>
            {recording
              ? `⏹ ${Math.floor(recDuration/60)}:${String(recDuration%60).padStart(2,"0")}`
              : "⏺ REC"}
          </button>

          <div style={styles.divider} />
          <label style={styles.label}>EVOLVE</label>
          <input type="range" min={0} max={1} step={0.01} value={evolveStrength}
            style={{ ...styles.slider, width: 60, accentColor: "#c084fc" }}
            onChange={e => setEvolveStrength(+e.target.value)} />
          <button style={{ ...styles.recBtn,
            background: evolveOn ? "#c084fc33" : "transparent",
            borderColor: evolveOn ? "#c084fc" : "#442255",
            color:       evolveOn ? "#c084fc" : "#553366",
            minWidth: 60 }}
            onClick={toggleEvolve}>
            {evolveOn ? "● LIVE" : "○ OFF"}
          </button>

          <button style={styles.stopBtn} onClick={stopAll}>■ Stop All</button>
        </div>
      </div>

      {/* Presets */}
      <div style={styles.presetRow}>
        {Object.keys(PRESETS).map(name => (
          <button key={name}
            style={{ ...styles.presetBtn, ...(activePreset === name ? styles.presetActive : {}) }}
            onClick={() => applyPreset(name)}>
            {name}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={{
          ...styles.presetBtn,
          background: showControl ? "rgba(192,132,252,0.2)" : "rgba(255,255,255,0.08)",
          borderColor: showControl ? "#c084fc" : "rgba(255,255,255,0.18)",
          color: showControl ? "#f3ddff" : "#d8e2dc",
          fontWeight: 700,
        }}
          onClick={() => setShowControl(v => !v)}>
          ⚡ MIDI / OSC
        </button>
      </div>

      {/* MIDI / OSC control panel */}
      {showControl && (
        <div style={styles.controlPanel}>
          {/* MIDI */}
          <div style={styles.controlSection}>
            <div style={styles.controlTitle}>MIDI</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button style={{
                ...styles.ctrlBtn,
                background: midiEnabled ? "rgba(125,222,146,0.18)" : "rgba(255,255,255,0.08)",
                borderColor: midiEnabled ? "#7dde92" : "#5c6a61",
                color: midiEnabled ? "#dff7e6" : "#edf3ef",
                fontWeight: 700,
              }}
                onClick={initMIDI}>
                {midiEnabled ? "✓ MIDI Ready" : "Enable MIDI"}
              </button>
              <button style={styles.ctrlBtn} onClick={resetMidiBindings}>
                Reset Learn
              </button>
            </div>
            <div style={styles.ctrlNote}>{midiLearnStatus}</div>
            <div style={{ ...styles.ctrlNote, color: "#667c70" }}>{midiLastMessage}</div>
            {midiEnabled && (
              <div style={styles.ctrlNote}>
                {midiInputs.length > 0
                  ? midiInputs.map((n, i) => <div key={i}>↳ {n}</div>)
                  : "No MIDI inputs detected yet."}
              </div>
            )}
            <div style={styles.midiMapList}>
              {MIDI_LEARN_TARGETS.map(target => {
                const binding = midiBindings[target.key];
                const isLearning = midiLearnTarget === target.key;
                return (
                  <div key={target.key} style={styles.midiMapRow}>
                    <div style={styles.midiMapMeta}>
                      <div style={styles.midiMapLabel}>{target.label}</div>
                      <div style={styles.midiMapValue}>
                        {binding ? describeMidiBinding(binding) : legacyMidiBindingLabel(target.key)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        style={{
                          ...styles.ctrlBtn,
                          borderColor: isLearning ? "#ffd866" : "#3a4a3c",
                          color: isLearning ? "#ffd866" : "#9bb09f",
                          minWidth: 72,
                        }}
                        onClick={() => beginMidiLearn(target.key)}>
                        {isLearning ? "Listening" : "Learn"}
                      </button>
                      {binding && (
                        <button style={{ ...styles.ctrlBtn, minWidth: 54 }} onClick={() => clearMidiBinding(target.key)}>
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={styles.ctrlNote}>
              Defaults stay active until you learn an override.
              <br/>
              Legacy toggle notes extend upward from C3 and param-0 stays on CC 70-88.
            </div>
          </div>

          {/* OSC */}
          <div style={styles.controlSection}>
            <div style={styles.controlTitle}>OSC (WebSocket bridge)</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input style={styles.ctrlInput} value={oscUrl}
                onChange={e => setOscUrl(e.target.value)} />
              {oscStatus === "connected"
                ? <button style={{ ...styles.ctrlBtn, borderColor: "#ff5050", color: "#ff8080" }}
                    onClick={disconnectOSC}>Disconnect</button>
                : <button style={{ ...styles.ctrlBtn, borderColor: "#c084fc", color: "#c084fc" }}
                    onClick={connectOSC}>Connect</button>
              }
            </div>
            <div style={{ ...styles.ctrlNote,
              color: oscStatus === "connected" ? "#7dde92"
                   : oscStatus === "error"     ? "#ff8080"
                   : "#556c5c" }}>
              {oscStatus}
            </div>
            <div style={styles.ctrlNote}>
              /ambigram/master/volume f<br/>
              /ambigram/master/reverb f<br/>
              /ambigram/layer/&lt;id&gt; f<br/>
              /ambigram/layer/&lt;id&gt;/on i<br/>
              /ambigram/param/&lt;id&gt;/&lt;paramId&gt; f<br/>
              /ambigram/thunder/strike i
            </div>
          </div>
        </div>
      )}

      {/* Layer groups */}
      <div style={styles.content}>
        {Object.entries(grouped).map(([cat, layers]) => (
          <div key={cat} style={styles.group}>
            <div style={styles.groupLabel}>{categoryLabel[cat]}</div>
            <div style={styles.layerRow}>
              {layers.map(layer => {
                const state = layerState[layer.id];
                const isThunder = layer.id === "thunder";
                const isOn = state.active || (isThunder && thunderAuto);
                const expanded = expandedCards.has(layer.id);
                const params = LAYER_PARAMS[layer.id] || [];
                const pState = paramState[layer.id] || {};

                return (
                  <div key={layer.id} style={{
                    ...styles.card,
                    width: expanded ? 240 : 110,
                    flexDirection: expanded ? "row" : "column",
                    alignItems: expanded ? "flex-start" : "center",
                    borderColor: isOn ? layer.color : "rgba(255,255,255,0.08)",
                    boxShadow: isOn ? `0 0 18px ${layer.color}55` : "none",
                  }}>

                    {/* Left column: always visible */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                      gap: 8, minWidth: surroundKey !== "stereo" ? 96 : 82 }}>
                      <div style={styles.cardTop}>
                        <span style={{ fontSize: 22 }}>{layer.icon}</span>
                        <span style={{ ...styles.cardLabel, color: isOn ? layer.color : "#aaa" }}>
                          {layer.label}
                        </span>
                      </div>

                      {/* Surround position dial — only shown in multichannel mode */}
                      {surroundKey !== "stereo" && (
                        <SurroundPositioner
                          azimuth={layerAzimuths[layer.id] ?? 0}
                          onChange={az => setSurroundAz(layer.id, az)}
                          color={layer.color}
                          format={SURROUND_FORMATS[surroundKey]}
                          size={68}
                        />
                      )}

                      <div style={{ ...styles.dot, background: isOn ? layer.color : "#333" }} />

                      {!isThunder && (
                        <VerticalFader
                          value={state.level}
                          onChange={v => setLayerLevel(layer.id, v)}
                          color={layer.color}
                          height={80}
                        />
                      )}

                      {isThunder ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
                          <button style={{ ...styles.toggleBtn, background: layer.color+"33",
                            borderColor: layer.color, color: layer.color }}
                            onClick={triggerThunder}>Strike</button>
                          <button style={{ ...styles.toggleBtn, fontSize: 10,
                            background: thunderAuto ? layer.color+"55" : "transparent",
                            borderColor: layer.color+"88",
                            color: thunderAuto ? layer.color : "#888" }}
                            onClick={() => { const n=!thunderAuto; setThunderAuto(n); engine.synths.thunder.setAutoMode(n); }}>
                            {thunderAuto ? "Auto ON" : "Auto OFF"}
                          </button>
                        </div>
                      ) : (
                        <button style={{ ...styles.toggleBtn,
                          background: state.active ? layer.color+"33" : "transparent",
                          borderColor: state.active ? layer.color : "#444",
                          color: state.active ? layer.color : "#666" }}
                          onClick={() => toggleLayer(layer.id)}>
                          {state.active ? "ON" : "OFF"}
                        </button>
                      )}

                      {params.length > 0 && (
                        <button style={{ ...styles.expandBtn,
                          borderColor: expanded ? layer.color+"88" : "#333",
                          color: expanded ? layer.color : "#555" }}
                          onClick={() => toggleExpand(layer.id)}>
                          {expanded ? "▲" : "▼"}
                        </button>
                      )}
                    </div>

                    {/* Right column: param sliders (visible when expanded) */}
                    {expanded && params.length > 0 && (
                      <div style={styles.paramPanel}>
                        {params.map(p => {
                          const cur = pState[p.id] ?? p.default;
                          const decimals = p.step < 1 ? (p.step < 0.01 ? 3 : 2) : 0;
                          return (
                            <div key={p.id} style={styles.paramRow}>
                              {/* Top row: label on left, editable value on right */}
                              <div style={styles.paramTopRow}>
                                <span style={{ ...styles.paramLabel, color: layer.color + "cc" }}>
                                  {p.label}
                                </span>
                                <div style={styles.paramValWrap}>
                                  <input
                                    type="number"
                                    min={p.min} max={p.max} step={p.step}
                                    value={cur.toFixed(decimals)}
                                    style={{ ...styles.paramNumInput, borderColor: layer.color + "55", color: layer.color }}
                                    onChange={e => {
                                      const v = parseFloat(e.target.value);
                                      if (!isNaN(v)) setParam(layer.id, p.id, Math.min(p.max, Math.max(p.min, v)));
                                    }}
                                    onKeyDown={e => {
                                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                                        e.preventDefault();
                                        const delta = (e.key === "ArrowUp" ? 1 : -1) * p.step * (e.shiftKey ? 10 : 1);
                                        setParam(layer.id, p.id, Math.min(p.max, Math.max(p.min, cur + delta)));
                                      }
                                    }}
                                  />
                                  <span style={styles.paramUnit}>{p.unit}</span>
                                </div>
                              </div>
                              {/* Full-width slider on its own row */}
                              <input type="range" min={p.min} max={p.max} step={p.step}
                                value={cur}
                                style={{ ...styles.paramSlider, accentColor: layer.color }}
                                onChange={e => setParam(layer.id, p.id, +e.target.value)} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Synthesis info footer */}
      <div style={styles.footer}>
        Physical Modeling · FM Synthesis · Analog Subtractive · Karplus-Strong · AM Synthesis
        &nbsp;·&nbsp; Pure Web Audio API — no samples
        &nbsp;·&nbsp; {actualRate ? `${(actualRate/1000).toFixed(actualRate % 1000 === 0 ? 0 : 1)} kHz` : `${sampleRate/1000} kHz`}
        &nbsp;·&nbsp; {bitDepth}-bit {bitDepth === 32 ? "float" : "PCM"} · 64-bit compute · TPDF dither
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────

const styles = {
  splash: {
    background: "linear-gradient(160deg, #0a1a0e 0%, #0d1f18 50%, #0a1510 100%)",
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Courier New', monospace",
  },
  splashInner: {
    textAlign: "center", padding: "60px 40px",
    background: "rgba(255,255,255,0.03)", borderRadius: 24,
    border: "1px solid rgba(100,200,120,0.15)",
    backdropFilter: "blur(12px)",
  },
  logo: { fontSize: 64, marginBottom: 12 },
  title: {
    color: "#7dde92", fontSize: 42, letterSpacing: 12,
    margin: "0 0 8px", fontWeight: 300,
  },
  subtitle: { color: "#6b9b76", fontSize: 14, lineHeight: 1.8, margin: "0 0 40px" },
  startBtn: {
    background: "rgba(125,222,146,0.12)", border: "1px solid #7dde92",
    color: "#7dde92", padding: "14px 40px", borderRadius: 8, fontSize: 16,
    cursor: "pointer", letterSpacing: 3, fontFamily: "inherit",
    transition: "all 0.2s",
  },
  hint: { color: "#446b4e", fontSize: 12, marginTop: 28, letterSpacing: 1 },

  root: {
    background: "linear-gradient(160deg, #080f0a 0%, #0b1810 50%, #080d0a 100%)",
    minHeight: "100vh", fontFamily: "'Courier New', monospace", color: "#ccc",
    padding: "0 0 40px",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "16px 24px", borderBottom: "1px solid rgba(125,222,146,0.1)",
    background: "rgba(0,0,0,0.4)", backdropFilter: "blur(8px)",
    position: "sticky", top: 0, zIndex: 10,
  },
  titleSmall: {
    color: "#7dde92", letterSpacing: 8, fontSize: 16, fontWeight: 300,
  },
  masterControls: { display: "flex", alignItems: "center", gap: 8 },
  label: { color: "#556c5c", fontSize: 11, letterSpacing: 2 },
  slider: { width: 90, accentColor: "#7dde92", cursor: "pointer" },
  stopBtn: {
    marginLeft: 16, background: "rgba(255,80,80,0.1)", border: "1px solid #ff5050",
    color: "#ff8080", padding: "6px 14px", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontFamily: "inherit",
  },

  presetRow: {
    display: "flex", gap: 8, padding: "12px 24px", overflowX: "auto",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  presetBtn: {
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
    color: "#b7c8bc", padding: "7px 16px", borderRadius: 20, cursor: "pointer",
    fontSize: 12, fontFamily: "inherit", whiteSpace: "nowrap", letterSpacing: 0.5,
    transition: "all 0.15s",
  },
  presetActive: {
    background: "rgba(125,222,146,0.15)", borderColor: "#7dde92", color: "#7dde92",
  },

  content: { padding: "24px 24px 0" },
  group: { marginBottom: 28 },
  groupLabel: {
    color: "#4a7a54", fontSize: 11, letterSpacing: 4, marginBottom: 12,
    textTransform: "uppercase",
  },
  layerRow: { display: "flex", gap: 14, flexWrap: "wrap" },

  card: {
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14, padding: "16px 14px", width: 110,
    display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
    transition: "border-color 0.3s, box-shadow 0.3s",
  },
  cardTop: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  cardLabel: { fontSize: 11, letterSpacing: 1, textAlign: "center", transition: "color 0.3s" },
  dot: { width: 6, height: 6, borderRadius: "50%", transition: "background 0.3s" },

  toggleBtn: {
    border: "1px solid #444", borderRadius: 6, padding: "5px 10px",
    cursor: "pointer", fontSize: 11, fontFamily: "inherit", letterSpacing: 1,
    transition: "all 0.15s", width: "100%",
  },

  footer: {
    textAlign: "center", color: "#2a4a32", fontSize: 10, letterSpacing: 1.5,
    padding: "32px 24px 0", borderTop: "1px solid rgba(255,255,255,0.03)", marginTop: 12,
  },

  // ── MIDI/OSC control panel styles ────────────
  controlPanel: {
    display: "flex", gap: 32, padding: "14px 24px",
    background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(192,132,252,0.15)",
    flexWrap: "wrap",
  },
  controlSection: {
    display: "flex", flexDirection: "column", gap: 6, minWidth: 280, flex: 1,
  },
  controlTitle: {
    color: "#c084fc", fontSize: 10, letterSpacing: 3, marginBottom: 2,
  },
  ctrlBtn: {
    background: "rgba(255,255,255,0.08)", border: "1px solid #58655d", borderRadius: 5,
    color: "#eef4f0", padding: "5px 14px", cursor: "pointer",
    fontSize: 11, fontFamily: "inherit", letterSpacing: 1, fontWeight: 600,
  },
  ctrlNote: {
    color: "#445", fontSize: 10, lineHeight: 1.7, letterSpacing: 0.5,
  },
  ctrlInput: {
    background: "#0a140c", border: "1px solid #2a3a2c", color: "#7dde92",
    borderRadius: 4, padding: "4px 8px", fontSize: 11,
    fontFamily: "'Courier New', monospace", flex: 1, outline: "none",
  },
  midiMapList: {
    display: "flex", flexDirection: "column", gap: 8, marginTop: 4,
    maxHeight: 320, overflowY: "auto", paddingRight: 4,
  },
  midiMapRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 10, padding: "8px 10px", borderRadius: 8,
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
  },
  midiMapMeta: {
    display: "flex", flexDirection: "column", gap: 3, minWidth: 0,
  },
  midiMapLabel: {
    color: "#c7d3ca", fontSize: 11, letterSpacing: 0.6,
  },
  midiMapValue: {
    color: "#6c8677", fontSize: 10, letterSpacing: 0.4,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },

  // ── Param panel styles ──────────────────────
  expandBtn: {
    border: "1px solid #333", borderRadius: 4, padding: "2px 8px",
    cursor: "pointer", fontSize: 9, background: "transparent", fontFamily: "inherit",
    letterSpacing: 1, transition: "all 0.15s", width: "100%",
  },
  paramPanel: {
    flex: 1, display: "flex", flexDirection: "column", gap: 6,
    paddingLeft: 10, borderLeft: "1px solid rgba(255,255,255,0.06)",
    minWidth: 0,
  },
  paramRow: {
    display: "flex", flexDirection: "column", gap: 3,
  },
  paramTopRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  paramLabel: {
    fontSize: 9, letterSpacing: 0.5, flexShrink: 0,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    maxWidth: "55%",
  },
  paramValWrap: {
    display: "flex", alignItems: "center", gap: 2,
  },
  paramNumInput: {
    width: 46, background: "#0a1510", border: "1px solid #2a4a34",
    color: "#9ddeaa", borderRadius: 3, padding: "1px 4px",
    fontSize: 9, fontFamily: "'Courier New', monospace",
    textAlign: "right", outline: "none",
    // hide browser spin arrows
    MozAppearance: "textfield",
  },
  paramUnit: {
    fontSize: 9, color: "#556", flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  paramSlider: {
    width: "100%", height: 4, cursor: "pointer",
    accentColor: "#7dde92",
  },

  // ── Format / record styles ──────────────────
  formatRow: {
    display: "flex", gap: 24, justifyContent: "center", margin: "0 0 32px",
  },
  formatGroup: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
  },
  formatLabel: {
    color: "#4a7a54", fontSize: 10, letterSpacing: 3,
  },
  select: {
    background: "#0e1f12", border: "1px solid #2a5a34", color: "#7dde92",
    borderRadius: 6, padding: "8px 14px", fontSize: 13, fontFamily: "'Courier New', monospace",
    cursor: "pointer", outline: "none",
  },
  selectSm: {
    background: "#0a140c", border: "1px solid #1e3d22", color: "#7dde92",
    borderRadius: 4, padding: "3px 8px", fontSize: 11, fontFamily: "'Courier New', monospace",
    cursor: "pointer", outline: "none",
  },
  divider: {
    width: 1, height: 20, background: "rgba(255,255,255,0.1)", margin: "0 4px",
  },
  recBtn: {
    border: "1px solid #882233", borderRadius: 6, padding: "5px 12px",
    cursor: "pointer", fontSize: 11, fontFamily: "'Courier New', monospace",
    letterSpacing: 1, transition: "all 0.15s", minWidth: 72,
  },
  rateWarn: {
    color: "#ffaa44", fontSize: 10, letterSpacing: 1,
  },
};
