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

function makeWhiteBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function makePinkBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
    b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
    b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
    d[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

function makeBrownBuffer(ctx, sec = 3) {
  const n = ctx.sampleRate * sec;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
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
  }

  async init() {
    if (this.ready) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();

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
    this.bands = [
      { f: 320, Q: 1.2 }, { f: 780, Q: 0.8 }, { f: 1800, Q: 0.6 },
      { f: 4200, Q: 0.5 }, { f: 9000, Q: 0.4 },
    ].map(({ f, Q }) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = Q;
      const g = ctx.createGain(); g.gain.value = f < 500 ? 0.9 : f < 2000 ? 0.6 : 0.35;
      bp.connect(g); g.connect(this.gainNode);
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
    const ctx = this.ctx; const t = ctx.currentTime;
    const dur = 3.5 + Math.random() * 4;

    const buf = makeBrownBuffer(ctx, Math.ceil(dur) + 1);
    const src = ctx.createBufferSource(); src.buffer = buf;

    // Rumble resonators
    const resonances = [48, 72, 96, 140, 210].map(freq => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = freq;
      bp.Q.value = 3 + Math.random() * 4;
      return bp;
    });

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(0.55 * this.level, t + 0.08);
    master.gain.setValueAtTime(0.55 * this.level, t + 0.3);
    master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    master.connect(this.dry); master.connect(this.wet);

    resonances.forEach(bp => {
      const g = ctx.createGain(); g.gain.value = 0.7;
      src.connect(bp); bp.connect(g); g.connect(master);
    });

    // Initial crack — bandlimited noise burst
    const crackBuf = makeWhiteBuffer(ctx, 0.15);
    const crack = ctx.createBufferSource(); crack.buffer = crackBuf;
    const crackHp = ctx.createBiquadFilter();
    crackHp.type = "highpass"; crackHp.frequency.value = 200;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.7 * this.level, t);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    crack.connect(crackHp); crackHp.connect(crackGain); crackGain.connect(this.dry);
    crack.start(t); crack.stop(t + 0.15);

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
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.4;
    this._lfo.connect(lfoGain); lfoGain.connect(this.gainNode.gain);
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
    this._timer = null;
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
    const ms = 400 + Math.random() * (3000 / (this.level + 0.15));
    this._timer = setTimeout(() => { this._drip(); this._schedule(); }, ms);
  }

  _drip() {
    const ctx = this.ctx; const t = ctx.currentTime;
    const freq = 300 + Math.random() * 1200;
    const buf = karplusStrong(ctx, freq, 0.992 + Math.random() * 0.005, 1.2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.25 * this.level;
    // tiny splash envelope
    const env = ctx.createGain();
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    src.connect(g); g.connect(env); env.connect(this.gainNode);
    src.start(t); src.stop(t + 1.4);
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
    this._oscs = [];
  }

  start() {
    if (this.active) return; this.active = true;
    const ctx = this.ctx;

    // Low swamp drone — cluster of detuned triangle oscs
    [55, 55.3, 110, 164.8, 82.4].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i < 2 ? "triangle" : "sine";
      osc.frequency.value = freq;
      // slow LFO pitch wobble
      const lfo = ctx.createOscillator(); lfo.type = "sine";
      lfo.frequency.value = 0.03 + i * 0.01;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.4;
      lfo.connect(lfoG); lfoG.connect(osc.frequency);

      const g = ctx.createGain(); g.gain.value = 0.07;
      osc.connect(g); g.connect(this.gainNode);
      osc.start(); lfo.start();
      this._oscs.push(osc, lfo);
    });

    // Brown noise undertone
    const brownBuf = makeBrownBuffer(ctx, 4);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = brownBuf; noiseSrc.loop = true;
    const noiseLp = ctx.createBiquadFilter(); noiseLp.type = "lowpass";
    noiseLp.frequency.value = 180;
    const noiseG = ctx.createGain(); noiseG.gain.value = 0.15;
    noiseSrc.connect(noiseLp); noiseLp.connect(noiseG); noiseG.connect(this.gainNode);
    noiseSrc.start(); this._oscs.push(noiseSrc);

    this.gainNode.gain.linearRampToValueAtTime(0.12 + 0.28 * this.level, ctx.currentTime + 3);
  }

  stop() {
    if (!this.active) return; this.active = false;
    this.gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 3);
    this._oscs.forEach(o => o.stop(this.ctx.currentTime + 3.5)); this._oscs = [];
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
//  LAYER DEFINITIONS (UI metadata)
// ─────────────────────────────────────────────

const LAYERS = [
  { id: "rain",      label: "Rain",       icon: "🌧️",  color: "#4a9eff", category: "weather" },
  { id: "waterfall", label: "Waterfall",  icon: "💧",  color: "#00c8ff", category: "weather" },
  { id: "wind",      label: "Wind",       icon: "🌬️",  color: "#a0c4ff", category: "weather" },
  { id: "thunder",   label: "Thunder",    icon: "⚡",   color: "#ffe066", category: "weather" },
  { id: "birds",     label: "Birds",      icon: "🐦",  color: "#7dde92", category: "nature"  },
  { id: "bees",      label: "Bees",       icon: "🐝",  color: "#ffd700", category: "nature"  },
  { id: "crickets",  label: "Crickets",   icon: "🦗",  color: "#98e08a", category: "nature"  },
  { id: "frogs",     label: "Frogs",      icon: "🐸",  color: "#4ecb71", category: "nature"  },
  { id: "drips",     label: "Water Drips",icon: "💦",  color: "#63d0f5", category: "nature"  },
  { id: "swamp",     label: "Swamp Drone",icon: "🌿",  color: "#6bcf8a", category: "everglades" },
  { id: "heron",     label: "Heron",      icon: "🦢",  color: "#c8e6c9", category: "everglades" },
  { id: "gator",     label: "Gator Rumble",icon: "🐊", color: "#8bc34a", category: "everglades" },
];

// ─────────────────────────────────────────────
//  REACT APP
// ─────────────────────────────────────────────

const engine = new AmbigramEngine();

export default function Ambigram() {
  const [started, setStarted] = useState(false);
  const [masterVol, setMasterVol] = useState(0.85);
  const [reverbMix, setReverbMix] = useState(0.22);
  const [activePreset, setActivePreset] = useState(null);
  const [thunderAuto, setThunderAuto] = useState(false);

  // layerState: { id → { active: bool, level: number } }
  const [layerState, setLayerState] = useState(() =>
    Object.fromEntries(LAYERS.map(l => [l.id, { active: false, level: 0.5 }]))
  );

  // Activity pulse for animated layers (birds, frogs, heron, gator)
  const [pulseIds, setPulseIds] = useState(new Set());

  const initAndStart = useCallback(async () => {
    await engine.init();
    setStarted(true);
  }, []);

  // Master volume
  useEffect(() => {
    if (started) engine.setMasterVol(masterVol);
  }, [masterVol, started]);

  // Reverb mix
  useEffect(() => {
    if (started) engine.setReverb(reverbMix);
  }, [reverbMix, started]);

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

  const applyPreset = useCallback(async (name) => {
    if (!started) await engine.init().then(() => setStarted(true));
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
  }, [started]);

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
          <button style={styles.startBtn} onClick={initAndStart}>
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
          <label style={{ ...styles.label, marginLeft: 16 }}>REVERB</label>
          <input type="range" min={0} max={1} step={0.01} value={reverbMix}
            style={styles.slider} onChange={e => setReverbMix(+e.target.value)} />
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
      </div>

      {/* Layer groups */}
      <div style={styles.content}>
        {Object.entries(grouped).map(([cat, layers]) => (
          <div key={cat} style={styles.group}>
            <div style={styles.groupLabel}>{categoryLabel[cat]}</div>
            <div style={styles.layerRow}>
              {layers.map(layer => {
                const state = layerState[layer.id];
                const isThunder = layer.id === "thunder";

                return (
                  <div key={layer.id} style={{
                    ...styles.card,
                    borderColor: state.active || (isThunder && thunderAuto)
                      ? layer.color : "rgba(255,255,255,0.08)",
                    boxShadow: state.active || (isThunder && thunderAuto)
                      ? `0 0 18px ${layer.color}55` : "none",
                  }}>
                    {/* Icon + name */}
                    <div style={styles.cardTop}>
                      <span style={{ fontSize: 24 }}>{layer.icon}</span>
                      <span style={{ ...styles.cardLabel, color: state.active ? layer.color : "#aaa" }}>
                        {layer.label}
                      </span>
                    </div>

                    {/* Active indicator */}
                    <div style={{
                      ...styles.dot,
                      background: (state.active || (isThunder && thunderAuto)) ? layer.color : "#333",
                    }} />

                    {/* Level fader (not for thunder) */}
                    {!isThunder && (
                      <div style={styles.faderWrap}>
                        <div style={styles.faderTrack}>
                          <div style={{
                            ...styles.faderFill,
                            height: `${state.level * 100}%`,
                            background: layer.color,
                          }} />
                        </div>
                        <input type="range" min={0} max={1} step={0.01}
                          value={state.level} orient="vertical"
                          style={styles.faderInput}
                          onChange={e => setLayerLevel(layer.id, +e.target.value)} />
                      </div>
                    )}

                    {/* Toggle / trigger button */}
                    {isThunder ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <button style={{
                          ...styles.toggleBtn,
                          background: layer.color + "33",
                          borderColor: layer.color,
                          color: layer.color,
                        }} onClick={triggerThunder}>
                          Strike
                        </button>
                        <button style={{
                          ...styles.toggleBtn,
                          background: thunderAuto ? layer.color + "55" : "transparent",
                          borderColor: layer.color + "88",
                          color: thunderAuto ? layer.color : "#888",
                          fontSize: 10,
                        }} onClick={() => {
                          const next = !thunderAuto;
                          setThunderAuto(next);
                          engine.synths.thunder.setAutoMode(next);
                        }}>
                          {thunderAuto ? "Auto ON" : "Auto OFF"}
                        </button>
                      </div>
                    ) : (
                      <button style={{
                        ...styles.toggleBtn,
                        background: state.active ? layer.color + "33" : "transparent",
                        borderColor: state.active ? layer.color : "#444",
                        color: state.active ? layer.color : "#666",
                      }} onClick={() => toggleLayer(layer.id)}>
                        {state.active ? "ON" : "OFF"}
                      </button>
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
};
