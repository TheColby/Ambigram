# AMBIGRAM
### AI-driven Ambient Sound Generation via Physical Modeling & Analog Synthesis

> *No samples. No loops. Every sound synthesized from first principles in real time.*

---

## What Is This

Ambigram is a pure-synthesis ambient sound engine built on the Web Audio API. It uses **physical modeling**, **analog subtractive synthesis**, **FM synthesis**, **AM synthesis**, and **Karplus-Strong string/drip models** to generate evolving nature soundscapes entirely in the browser — no audio files, no prerecorded loops.

The goal: procedural, living sound that never repeats. Rain that varies in density and drop character. Frogs that call at organic intervals. A great blue heron that rasps across the swamp every few minutes. An alligator that bellows with infrasonic authority.

---

## Synthesis Techniques

### Physical Modeling

**Karplus-Strong Algorithm**
Used for rain drops and water drips. A noise burst is fed into a feedback delay line with a low-pass filter. The delay time determines pitch; the filter coefficient controls decay. Each drop gets a randomized frequency (200–3000 Hz), giving the rain a natural, non-repeating character.

```
noise → delay line → LPF ──┐
             ↑              │
             └──────────────┘
output tapped from delay line
```

**Resonator Banks (Waterfall)**
Five parallel bandpass filters tuned to the modal resonances of falling water (320, 780, 1800, 4200, 9000 Hz). Brown noise drives the low roar; pink noise adds upper-frequency spray. The relative gains of each band can shift to simulate proximity and volume.

**Alligator Infrasonic Model**
The American alligator's territorial bellow peaks below 30 Hz. Ambigram synthesizes this with a cluster of sine oscillators at 22–88 Hz with exponential envelope swells, plus brown noise filtered below 120 Hz for the water-churn effect. Most consumer speakers won't reproduce the sub-bass — but it still alters the room.

---

### Analog Subtractive Synthesis

**Wind**
White noise → cascaded two-pole lowpass filters → output. A slow LFO (0.08 Hz) modulates the filter cutoff (±500 Hz) to simulate gusts. A second amplitude LFO (0.04 Hz) produces the swell and ebb of wind through trees. This approximates the behavior of a Moog-style 4-pole ladder filter without requiring AudioWorklet.

**Rain Surface Texture**
Pink noise (Paul Kellet's algorithm, computed into a looping buffer) → bandpass filter centered at 2800 Hz → high-shelf boost at 7 kHz → high-pass at 250 Hz. The result is the characteristic "white noise hiss" of rain on surfaces, with the mud-frequency content rolled off.

**Crickets**
Three sine oscillators at 4600–5100 Hz, each amplitude-modulated by a sine LFO at ~14 Hz (the chirp rate). The slight frequency offset between voices creates natural phase beating.

**Bees**
Seven detuned sawtooth and square oscillators at ~220 Hz (±2% pitch spread). Amplitude-modulated at 210–250 Hz to simulate wing-beat frequency. Filtered through a low-pass at 1800 Hz for the characteristic buzz timbre. The detuning between voices produces the wavering, organic quality of a real swarm.

**Swamp Drone**
A cluster of triangle and sine oscillators at 55, 110, 164.8, and 82.4 Hz (natural harmonic series), each with its own slow pitch-wobble LFO (0.03–0.07 Hz). Brown noise filtered below 180 Hz adds the subsurface rumble of water and mud. Together they produce the felt, vibrational quality of a subtropical wetland.

---

### FM Synthesis

**Birds (6 species)**
Each bird call uses a carrier oscillator modulated by a second oscillator. The carrier-to-modulator frequency ratio and modulation depth define the species character:

| Species     | Carrier (Hz) | Mod Ratio | Mod Depth | Chirps |
|-------------|-------------|-----------|-----------|--------|
| Wren        | 3200        | 2.1       | 1800      | 8      |
| Warbler     | 2800        | 1.5       | 900       | 5      |
| Sparrow     | 2100        | 3.2       | 1200      | 12     |
| Cardinal    | 1600        | 1.0       | 600       | 3      |
| Mockingbird | 2400        | 1.8       | 1400      | 6      |
| Thrush      | 1900        | 2.5       | 1100      | 4      |

Each call instance gets ±15% pitch randomization. A vibrato LFO (6–9 Hz, ±15 Hz depth) adds natural wavering. Birds are triggered stochastically — call frequency scales with the layer level setting.

**Frogs (4 Everglades species)**
Barking treefrog, bullfrog, green treefrog, and chorus frog — each modeled with species-specific FM parameters and repetition rates. The carrier frequency glides downward across the call duration (bullfrog's characteristic falling pitch). A bandpass resonator at 70% of carrier frequency adds the vocal sac body resonance.

**Great Blue Heron**
Three-squawk call sequence using sawtooth FM synthesis at 280→180 Hz with a high-pass filter above 400 Hz to emphasize the rasp. Triggered every 8–20 minutes on a random schedule.

---

### Signal Chain

```
[Synth Layers]
      │
      ├─── dryGain ─────────────────────────────────┐
      │                                             │
      └─── reverbSend → Convolver (3.2s IR) ────────┤
                                                    │
                                              masterGain
                                                    │
                                             destination
```

The reverb impulse response is synthesized — exponential noise decay with an 18ms pre-delay — no convolution files required. Reverb mix is continuously variable.

---

## Sound Layers

### Weather
| Layer     | Synthesis Method                          |
|-----------|-------------------------------------------|
| Rain      | Pink noise (bandpass/shelf) + Karplus-Strong drops |
| Waterfall | Brown + pink noise through 5-band resonator bank |
| Wind      | White noise + cascaded LPF + dual LFO modulation |
| Thunder   | Modal resonators on brown noise + crack transient |

### Nature
| Layer       | Synthesis Method                        |
|-------------|------------------------------------------|
| Birds       | 6-species FM synthesis, stochastic scheduling |
| Bees        | 7-voice detuned oscillator cluster, AM wing beats |
| Crickets    | 3-voice sine AM at 14 Hz chirp rate     |
| Frogs       | 4-species FM + resonator, pitch-glide envelope |
| Water Drips | Karplus-Strong physical model, 200–1200 Hz |

### Everglades
| Layer       | Synthesis Method                        |
|-------------|------------------------------------------|
| Swamp Drone | 5-osc harmonic cluster + brown noise undertone |
| Heron       | Sawtooth FM rasp, 3-squawk sequence     |
| Gator Rumble| Infrasonic sine cluster (22–88 Hz) + brown noise |

---

## Scene Presets

Presets set all layer levels and states simultaneously:

- **Everglades Dusk** — swamp drone, heavy frogs, crickets, gator, heron, light wind
- **Monsoon Rain** — heavy rain, auto-thunder, wind, rising frogs
- **Forest Morning** — birds, bees, wind, waterfall, water drips, scattered frogs
- **Waterfall Gorge** — dominant waterfall, drips, birds, light wind
- **Night Swamp** — maximum swamp, frogs, crickets, gator bellows, no birds
- **Bee Meadow** — bees, birds, gentle wind, waterfall background

---

## Architecture

```
ambigram.jsx
│
├── Noise Buffer Factories
│   ├── makeWhiteBuffer()    — flat spectrum
│   ├── makePinkBuffer()     — Paul Kellet's algorithm (-3dB/oct)
│   └── makeBrownBuffer()    — Brownian motion (-6dB/oct)
│
├── makeReverb()             — synthetic convolution IR
├── karplusStrong()          — physical string/drip model
│
├── AmbigramEngine           — AudioContext, master chain, synth registry
│
├── Synthesizers
│   ├── RainSynth            — pink noise + Karplus drops
│   ├── WaterfallSynth       — brown/pink → resonator bank
│   ├── WindSynth            — white noise + LFO-swept LPF
│   ├── ThunderSynth         — modal resonators + crack transient
│   ├── BirdSynth            — 6-species FM, stochastic voice scheduling
│   ├── BeeSynth             — 7-osc AM cluster
│   ├── CricketSynth         — 3-voice pulsed sine
│   ├── FrogSynth            — 4-species FM + resonator
│   ├── WaterDripSynth       — Karplus-Strong
│   ├── SwampSynth           — harmonic drone + brown noise
│   ├── HeronSynth           — FM rasp, random long-interval calls
│   └── GatorSynth           — infrasonic modal synthesis
│
├── PRESETS                  — 6 named scene configurations
├── LAYERS                   — UI metadata (label, icon, color, category)
│
└── React App (Ambigram)     — mixer UI, preset control, master chain
```

---

## Design Philosophy

**No samples.** Every sound is computed in real time from mathematical models of physical processes. This means the soundscape is theoretically infinite — it will never loop or repeat at a macro scale, even if individual synthesis loops exist at the micro level.

**Organic timing.** Creatures are triggered stochastically, not on metronome intervals. The distribution of call timing can be biased toward realistic ecological densities by adjusting layer levels.

**Analog character.** Subtractive synthesis layers use LFO modulation, filter sweeps, and oscillator detuning to avoid the sterile perfection of purely digital sound. The goal is the warmth of hardware synthesis applied to naturalistic sound design.

**Composability.** Every layer is independent with its own gain node and reverb send. You can mix Everglades frogs with Norwegian wind and waterfall without anything clashing — the synthesis models are physically-grounded enough that they coexist naturally.

---

## Extending the Engine

To add a new synthesizer:

1. Create a class with `start()`, `stop()`, and `setLevel(v)` methods
2. Accept `(ctx, dryOut, wetOut)` in the constructor
3. Create your gain node: `this.gainNode.connect(dry); this.gainNode.connect(wet);`
4. Register it in `AmbigramEngine.init()`: `this.synths.mySound = new MySynth(...)`
5. Add a layer entry to the `LAYERS` array
6. Optionally add it to relevant presets in `PRESETS`

---

## Stack

- **React** (hooks) — UI state and rendering
- **Web Audio API** — all synthesis and signal routing
- **Zero external audio dependencies** — no Tone.js, no samples, no CDN audio

---

*Built for the Everglades and everywhere else that hums.*
