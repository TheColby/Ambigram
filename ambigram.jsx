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

// ─────────────────────────────────────────────
//  MASTER ENGINE
// ─────────────────────────────────────────────

class AmbigramEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverbSend = null;
    this.reverb = null;
    this.drySend = null;
    this.synths = {};
    this.ready = false;
    this.sampleRate = 96000;
  }

  async teardown() {
    if (!this.ctx) return;
    // Stop all active synths gracefully
    Object.values(this.synths).forEach(s => { try { s.stop && s.stop(); } catch(_) {} });
    await this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.reverbSend = null;
    this.reverb = null;
    this.drySend = null;
    this.synths = {};
    this.ready = false;
  }

  async init(sampleRate = this.sampleRate) {
    if (this.ready) return;
    this.sampleRate = sampleRate;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    // Actual rate the browser granted (may differ from requested)
    this.actualSampleRate = this.ctx.sampleRate;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);

    // Wet path — reverb
    this.reverb = makeReverb(this.ctx, 3.2);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

    // Dry path
    this.drySend = this.ctx.createGain();
    this.drySend.gain.value = 1.0;
    this.drySend.connect(this.master);

    const { ctx, drySend, reverbSend } = this;

    this.synths = {
      rain:       new RainSynth(ctx, drySend, reverbSend),
      waterfall:  new WaterfallSynth(ctx, drySend, reverbSend),
      wind:       new WindSynth(ctx, drySend, reverbSend),
      thunder:    new ThunderSynth(ctx, drySend, reverbSend),
      birds:      new BirdSynth(ctx, drySend, reverbSend),
      bees:       new BeeSynth(ctx, drySend, reverbSend),
      crickets:   new CricketSynth(ctx, drySend, reverbSend),
      frogs:      new FrogSynth(ctx, drySend, reverbSend),
      drips:      new WaterDripSynth(ctx, drySend, reverbSend),
      swamp:      new SwampSynth(ctx, drySend, reverbSend),
      heron:      new HeronSynth(ctx, drySend, reverbSend),
      gator:      new GatorSynth(ctx, drySend, reverbSend),
    };

    this.ready = true;
  }

  setMasterVol(v) {
    if (!this.master) return;
    this.master.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.05);
  }

  setReverb(mix) {
    if (!this.reverbSend) return;
    this.reverbSend.gain.linearRampToValueAtTime(mix * 0.45, this.ctx.currentTime + 0.1);
  }
}

// ─────────────────────────────────────────────
//  WAV ENCODER — 16-bit PCM, 24-bit PCM, 32-bit IEEE float
//  All arithmetic stays in 64-bit JS doubles until final write
// ─────────────────────────────────────────────

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWAV(left, right, sampleRate, bitDepth) {
  const numCh   = right ? 2 : 1;
  const numFrames = left.length;
  const bps     = bitDepth === 24 ? 3 : bitDepth / 8; // bytes per sample
  const blockAlign = numCh * bps;
  const byteRate   = sampleRate * blockAlign;
  const dataSize   = numFrames * numCh * bps;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const channels = right ? [left[i], right[i]] : [left[i]];
    for (const s of channels) {
      const clamped = Math.max(-1, Math.min(1, s));
      if (bitDepth === 16) {
        // 64-bit double → Int16 with TPDF dither
        const dithered = clamped + tpdf() * 2;
        view.setInt16(offset, Math.round(dithered * 0x7FFF), true);
        offset += 2;
      } else if (bitDepth === 24) {
        // 64-bit double → Int24 with TPDF dither
        const dithered = clamped + tpdf();
        const val = Math.round(dithered * 0x7FFFFF);
        view.setUint8(offset,     val & 0xFF);
        view.setUint8(offset + 1, (val >> 8)  & 0xFF);
        view.setUint8(offset + 2, (val >> 16) & 0xFF);
        offset += 3;
      } else {
        // 32-bit IEEE float — no dither needed, native format
        view.setFloat32(offset, clamped, true);
        offset += 4;
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

// ─────────────────────────────────────────────
//  RECORDER NODE — taps master bus, accumulates stereo PCM
//  Uses ScriptProcessorNode (deprecated but universally supported).
//  bufferSize 2048 keeps latency minimal at 96kHz.
// ─────────────────────────────────────────────

class RecorderNode {
  constructor(ctx, sourceNode) {
    this.ctx = ctx;
    this.recording = false;
    this._chunksL = [];
    this._chunksR = [];
    this._totalFrames = 0;

    // ScriptProcessorNode: 2 in, 2 out — must stay connected to destination
    this._proc = ctx.createScriptProcessor(2048, 2, 2);
    this._proc.onaudioprocess = (e) => {
      if (!this.recording) return;
      // Copy both channels (Float32 from Web Audio = 32-bit in flight,
      // but we immediately upcast to 64-bit doubles via slice())
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.getChannelData(1);
      this._chunksL.push(new Float64Array(L)); // 64-bit storage
      this._chunksR.push(new Float64Array(R));
      this._totalFrames += L.length;
    };

    sourceNode.connect(this._proc);
    this._proc.connect(ctx.destination); // required or callback never fires
  }

  start() {
    this._chunksL = []; this._chunksR = [];
    this._totalFrames = 0;
    this.recording = true;
  }

  stop() {
    this.recording = false;
    // Flatten chunks → two contiguous Float64Arrays
    const L = new Float64Array(this._totalFrames);
    const R = new Float64Array(this._totalFrames);
    let off = 0;
    for (let i = 0; i < this._chunksL.length; i++) {
      L.set(this._chunksL[i], off);
      R.set(this._chunksR[i], off);
      off += this._chunksL[i].length;
    }
    return { L, R, frames: this._totalFrames };
  }

  destroy() {
    this._proc.disconnect();
  }
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

    // LFO for filter sweep (gusts)
    this.lfo = ctx.createOscillator(); this.lfo.type = "sine";
    this.lfo.frequency.value = 0.08;
    this.lfoGain = ctx.createGain(); this.lfoGain.gain.value = 500;
    this.lfo.connect(this.lfoGain); this.lfoGain.connect(this.lp1.frequency);
    this.lfo.start();

    // Second slow LFO for amplitude swell
    this.ampLfo = ctx.createOscillator(); this.ampLfo.type = "sine";
    this.ampLfo.frequency.value = 0.04;
    this.ampLfoGain = ctx.createGain(); this.ampLfoGain.gain.value = 0;
    this.ampLfo.connect(this.ampLfoGain);
    this.ampLfoGain.connect(this.gainNode.gain);
    this.ampLfo.start();

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

// ─────────────────────────────────────────────
//  THUNDER — low-frequency noise with modal resonators
// ─────────────────────────────────────────────

class ThunderSynth {
  constructor(ctx, dry, wet) {
    this.ctx = ctx; this.level = 0.8;
    this.dry = dry; this.wet = wet;
    this._autoTimer = null; this.autoMode = false;
  }

  trigger() {
    const ctx = this.ctx;
    // Start well ahead of currentTime so all param scheduling is deterministic
    const t   = ctx.currentTime + 0.05;
    const dur = 3.5 + Math.random() * 4;

    // ── Rumble — pre-faded noise buffer (fade-in baked into sample data)
    // This avoids ALL gain scheduling on the rumble path and eliminates
    // the click that happens when a non-zero sample suddenly appears.
    const fadeMs = 120; // ms of sample-level fade-in
    const fadeSamples = Math.round(ctx.sampleRate * fadeMs / 1000);
    const rumbleBuf  = makeBrownBuffer(ctx, Math.ceil(dur) + 1);
    const rumbleData = rumbleBuf.getChannelData(0);
    for (let i = 0; i < fadeSamples && i < rumbleData.length; i++) {
      rumbleData[i] *= i / fadeSamples; // linear fade-in in sample domain
    }

    const src = ctx.createBufferSource(); src.buffer = rumbleBuf;

    const resonances = [48, 72, 96, 140, 210].map(freq => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = freq;
      bp.Q.value = 3 + Math.random() * 4;
      return bp;
    });

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.55 * this.level, t); // constant — no ramp needed
    master.gain.setValueAtTime(0.55 * this.level, t + 0.5);
    master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    master.connect(this.dry); master.connect(this.wet);

    resonances.forEach(bp => {
      const g = ctx.createGain(); g.gain.value = 0.7;
      src.connect(bp); bp.connect(g); g.connect(master);
    });

    // ── Crack — similarly pre-faded in sample domain
    const crackBuf  = makeWhiteBuffer(ctx, 0.25);
    const crackData = crackBuf.getChannelData(0);
    const crackFade = Math.round(ctx.sampleRate * 0.006); // 6ms
    for (let i = 0; i < crackFade && i < crackData.length; i++) {
      crackData[i] *= i / crackFade;
    }
    // Also apply the amplitude envelope in sample domain
    const crackTotal = crackData.length;
    for (let i = 0; i < crackTotal; i++) {
      const env = Math.pow(1 - i / crackTotal, 1.8); // exponential decay shape
      crackData[i] *= env * 0.65 * this.level;
    }

    const crack   = ctx.createBufferSource(); crack.buffer = crackBuf;
    const crackHp = ctx.createBiquadFilter();
    crackHp.type = "highpass"; crackHp.frequency.value = 180;
    const crackLp = ctx.createBiquadFilter();
    crackLp.type = "lowpass";  crackLp.frequency.value = 7000;
    // No gain node on crack path — envelope is baked into the buffer
    crack.connect(crackHp); crackHp.connect(crackLp); crackLp.connect(this.dry);
    crack.start(t); crack.stop(t + 0.26);

    src.start(t); src.stop(t + dur + 0.1);
  }

  setAutoMode(on) {
    this.autoMode = on;
    if (on) this._scheduleAuto(); else clearTimeout(this._autoTimer);
  }

  _scheduleAuto() {
    if (!this.autoMode) return;
    const delay = 8000 + Math.random() * 25000;
    this._autoTimer = setTimeout(() => { this.trigger(); this._scheduleAuto(); }, delay);
  }

  setLevel(v) { this.level = v; }
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

const FROG_TYPES = [
  { f: 600,  mr: 3.5, md: 280, dur: 0.18, reps: 2 },  // barking treefrog
  { f: 420,  mr: 2.0, md: 180, dur: 0.35, reps: 1 },  // bullfrog
  { f: 850,  mr: 4.2, md: 340, dur: 0.12, reps: 5 },  // green treefrog
  { f: 1100, mr: 5.0, md: 500, dur: 0.08, reps: 8 },  // chorus frog
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
    this.gainNode.gain.linearRampToValueAtTime(0.15 + 0.3 * this.level, this.ctx.currentTime + 1);
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
      this.gainNode.gain.linearRampToValueAtTime(0.12 + 0.33 * v, this.ctx.currentTime + 0.2);
  }

  _scheduleFrog() {
    if (!this.active) return;
    const delay = 600 + Math.random() * (4000 / (this.level + 0.3));
    const t = setTimeout(() => { if (this.active) { this._croak(); this._scheduleFrog(); } }, delay);
    this._timers.push(t);
  }

  _croak() {
    const ft = FROG_TYPES[Math.floor(Math.random() * FROG_TYPES.length)];
    const ctx = this.ctx; const pitchM = 0.88 + Math.random() * 0.24;

    for (let i = 0; i < ft.reps; i++) {
      const t0 = ctx.currentTime + i * (ft.dur * 1.4) + Math.random() * 0.015;
      const carrier = ctx.createOscillator(); carrier.type = "sine";
      carrier.frequency.value = ft.f * pitchM;
      // pitch glide downward
      carrier.frequency.linearRampToValueAtTime(ft.f * pitchM * 0.92, t0 + ft.dur);

      const mod = ctx.createOscillator(); mod.type = "sine";
      mod.frequency.value = ft.f * pitchM * ft.mr;
      const modG = ctx.createGain(); modG.gain.value = ft.md;
      mod.connect(modG); modG.connect(carrier.frequency);

      const env = ctx.createGain(); env.gain.value = 0;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.18 * this.level, t0 + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + ft.dur);

      // Body resonator
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
      bp.frequency.value = ft.f * 0.7; bp.Q.value = 6;
      const bpG = ctx.createGain(); bpG.gain.value = 0.5;

      carrier.connect(env); carrier.connect(bp);
      bp.connect(bpG); bpG.connect(this.gainNode);
      env.connect(this.gainNode);

      carrier.start(t0); mod.start(t0);
      carrier.stop(t0 + ft.dur + 0.02); mod.stop(t0 + ft.dur + 0.02);
    }
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
    { id: "level",     label: "Strike Vol",   min: 0,    max: 1,    step: 0.01, default: 0.8, unit: "",
      apply: (s, v) => (s.level = v) },
    { id: "autoMin",   label: "Auto Min (s)", min: 4,    max: 60,   step: 1,    default: 8,   unit: "s",
      apply: (s, v) => (s.autoMin = v * 1000) },
    { id: "autoMax",   label: "Auto Max (s)", min: 10,   max: 120,  step: 1,    default: 33,  unit: "s",
      apply: (s, v) => (s.autoMax = v * 1000) },
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
  swamp: [
    { id: "rootPitch", label: "Root Pitch",   min: 30,   max: 120,  step: 1,    default: 55,  unit: "Hz",
      apply: (s, v) => s._oscs && s._oscs.filter(o=>o.frequency).forEach((o,i) => {
        const ratios=[1,1.005,2,3,1.5]; o.frequency.value = v*(ratios[i]||1); }) },
    { id: "wobbleRate",label: "Wobble Rate",  min: 0.01, max: 0.2,  step: 0.005,default: 0.04,unit: "Hz",
      apply: (s, v) => s._lfos && s._lfos.forEach((l,i) => l.frequency && (l.frequency.value = v+i*0.01)) },
    { id: "noiseLp",   label: "Mud Cutoff",   min: 40,   max: 600,  step: 10,   default: 180, unit: "Hz",
      apply: (s, v) => s._noiseLp && (s._noiseLp.frequency.value = v) },
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
  { id: "birds",     label: "Birds",      icon: "🐦",  color: "#7dde92", category: "nature"  },
  { id: "bees",      label: "Bees",       icon: "🐝",  color: "#ffd700", category: "nature"  },
  { id: "crickets",  label: "Crickets",   icon: "🦗",  color: "#98e08a", category: "nature"  },
  { id: "frogs",     label: "Frogs",      icon: "🐸",  color: "#4ecb71", category: "nature"  },
  { id: "drips",     label: "Drops",      icon: "💦",  color: "#63d0f5", category: "nature"  },
  { id: "swamp",     label: "Swamp Drone",icon: "🌿",  color: "#6bcf8a", category: "everglades" },
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
//    CC 20–31          → Layer levels (rain, waterfall, wind, thunder,
//                         birds, bees, crickets, frogs, drips, swamp,
//                         heron, gator)
//    CC 64 (Sustain)   → Thunder strike (gate high → trigger)
//    CC 70–81          → First param of each layer (fine-tune live)
//    Note On C3-B3     → Layer on/off toggle (12 semitones = 12 layers)
// ─────────────────────────────────────────────

const LAYER_ORDER = ["rain","waterfall","wind","thunder","birds","bees",
                     "crickets","frogs","drips","swamp","heron","gator"];

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

export default function Ambigram() {
  const [started, setStarted] = useState(false);
  const [masterVol, setMasterVol] = useState(0.85);
  const [reverbMix, setReverbMix] = useState(0.22);
  const [activePreset, setActivePreset] = useState(null);
  const [thunderAuto, setThunderAuto] = useState(false);
  const [sampleRate, setSampleRate] = useState(96000);
  const [bitDepth, setBitDepth]     = useState(32);
  const [actualRate, setActualRate] = useState(null);
  const [recording, setRecording]   = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const recorderRef  = useRef(null);
  const recTimerRef  = useRef(null);

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
      if (event.controller >= 20 && event.controller <= 31) {
        return handleCC(`layer:${LAYER_ORDER[event.controller - 20]}`, event.value01);
      }
      if (event.controller >= 70 && event.controller <= 81) {
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

    if (event.type === "noteon" && event.note >= 48 && event.note <= 59) {
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

  const initAndStart = useCallback(async (sr = sampleRate) => {
    await engine.init(sr);
    setActualRate(engine.actualSampleRate);
    setStarted(true);
  }, [sampleRate]);

  // Reinitialize engine when sample rate changes after first start
  const changeSampleRate = useCallback(async (newRate) => {
    setSampleRate(newRate);
    if (!started) return;
    // Stop recorder if running
    if (recorderRef.current) {
      recorderRef.current.destroy();
      recorderRef.current = null;
      setRecording(false);
      clearInterval(recTimerRef.current);
    }
    // Tear down and rebuild
    await engine.teardown();
    setStarted(false);
    setLayerState(Object.fromEntries(LAYERS.map(l => [l.id, { active: false, level: 0.5 }])));
    setThunderAuto(false);
    await engine.init(newRate);
    setActualRate(engine.actualSampleRate);
    setStarted(true);
  }, [started]);

  const startRecording = useCallback(() => {
    if (!started || recording) return;
    const recorder = new RecorderNode(engine.ctx, engine.master);
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
    setRecDuration(0);
    recTimerRef.current = setInterval(() => setRecDuration(d => d + 1), 1000);
  }, [started, recording]);

  const stopRecording = useCallback(() => {
    if (!recorderRef.current) return;
    clearInterval(recTimerRef.current);
    const { L, R, frames } = recorderRef.current.stop();
    recorderRef.current.destroy();
    recorderRef.current = null;
    setRecording(false);
    setRecDuration(0);

    if (frames === 0) return;
    const sr  = engine.actualSampleRate || engine.sampleRate;
    const wav = encodeWAV(L, R, sr, bitDepth);
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadWAV(wav, `ambigram-${ts}-${sr}hz-${bitDepth}bit.wav`);
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
          </div>

          <button style={styles.startBtn} onClick={() => initAndStart(sampleRate)}>
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
        <button style={{ ...styles.presetBtn, borderColor: showControl ? "#c084fc88" : undefined,
          color: showControl ? "#c084fc" : undefined }}
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
              <button style={{ ...styles.ctrlBtn, borderColor: midiEnabled ? "#7dde92" : "#444",
                color: midiEnabled ? "#7dde92" : "#888" }}
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
              Legacy toggle notes remain on C3-B3 and param-0 stays on CC 70-81.
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
                      gap: 8, minWidth: 82 }}>
                      <div style={styles.cardTop}>
                        <span style={{ fontSize: 22 }}>{layer.icon}</span>
                        <span style={{ ...styles.cardLabel, color: isOn ? layer.color : "#aaa" }}>
                          {layer.label}
                        </span>
                      </div>

                      <div style={{ ...styles.dot, background: isOn ? layer.color : "#333" }} />

                      {!isThunder && (
                        <div style={styles.faderWrap}>
                          <div style={styles.faderTrack}>
                            <div style={{ ...styles.faderFill, height: `${state.level * 100}%`, background: layer.color }} />
                          </div>
                          <input type="range" min={0} max={1} step={0.01}
                            value={state.level} orient="vertical"
                            style={styles.faderInput}
                            onChange={e => setLayerLevel(layer.id, +e.target.value)} />
                        </div>
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
                        {params.map(p => (
                          <div key={p.id} style={styles.paramRow}>
                            <label style={{ ...styles.paramLabel, color: layer.color + "cc" }}>
                              {p.label}
                            </label>
                            <input type="range" min={p.min} max={p.max} step={p.step}
                              value={pState[p.id] ?? p.default}
                              style={{ ...styles.paramSlider, accentColor: layer.color }}
                              onChange={e => setParam(layer.id, p.id, +e.target.value)} />
                            <span style={styles.paramVal}>
                              {(pState[p.id] ?? p.default).toFixed(
                                p.step < 1 ? (p.step < 0.01 ? 3 : 2) : 0
                              )}{p.unit}
                            </span>
                          </div>
                        ))}
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
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
    color: "#7a9e82", padding: "7px 16px", borderRadius: 20, cursor: "pointer",
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

  faderWrap: { position: "relative", width: 30, height: 80 },
  faderTrack: {
    position: "absolute", left: "50%", transform: "translateX(-50%)",
    width: 4, height: "100%", background: "#1a2a1c", borderRadius: 2,
    display: "flex", flexDirection: "column", justifyContent: "flex-end",
  },
  faderFill: { width: "100%", borderRadius: 2, transition: "height 0.1s" },
  faderInput: {
    position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
    width: 80, height: 30, opacity: 0, cursor: "pointer",
    writingMode: "vertical-lr",
  },

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
    background: "transparent", border: "1px solid #444", borderRadius: 5,
    color: "#888", padding: "5px 14px", cursor: "pointer",
    fontSize: 11, fontFamily: "inherit", letterSpacing: 1,
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
    display: "flex", alignItems: "center", gap: 6,
  },
  paramLabel: {
    fontSize: 9, letterSpacing: 0.5, width: 76, flexShrink: 0,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },
  paramSlider: {
    flex: 1, height: 2, cursor: "pointer", minWidth: 0,
  },
  paramVal: {
    fontSize: 9, color: "#556", width: 38, textAlign: "right", flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
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
