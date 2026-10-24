#!/usr/bin/env python3
"""
PhyMathia / film score generator.
120 BPM, 80.0 s, deterministic (seeded), additive synthesis + FFT reverb.
No samples, no external audio: every sound is computed here.

Grid contract with the picture:
  beat = 0.5 s, bar = 2.0 s, 16th = 0.125 s
  hit points (s):  0.0 5.0 10.0 18.0 23.0 34.0 38.0 46.0 54.0 62.0 74.0
"""
import numpy as np
import wave

SR = 44100
DUR = 80.0
N = int(SR * DUR)
BPM = 120.0
BEAT = 60.0 / BPM          # 0.5
BAR = BEAT * 4             # 2.0
S16 = BEAT / 4             # 0.125

rs = np.random.RandomState(20261023)
L = np.zeros(N)
R = np.zeros(N)
SEND = np.zeros(N)         # reverb send bus


def pan_gains(pan):
    a = (pan + 1.0) * np.pi / 4.0
    return np.cos(a), np.sin(a)


def add(sig, t0, pan=0.0, gain=1.0, wet=0.0):
    i0 = int(round(t0 * SR))
    if i0 >= N or i0 < 0:
        return
    n = min(len(sig), N - i0)
    gl, gr = pan_gains(pan)
    L[i0:i0 + n] += sig[:n] * gain * gl
    R[i0:i0 + n] += sig[:n] * gain * gr
    if wet:
        SEND[i0:i0 + n] += sig[:n] * gain * wet


def env_ar(n, attack, release):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    r = np.clip((n / SR - t) / max(release, 1e-4), 0, 1)
    return a * r


# ---------------------------------------------------------------- instruments
def kick(dur=0.5, punch=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 46 + 105 * np.exp(-t / 0.030)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.20)
    click = rs.randn(n) * np.exp(-t / 0.0035) * 0.40 * punch
    return np.tanh((body + click) * 1.7)


def snare(dur=0.30):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rs.randn(n)
    noise = np.diff(np.concatenate([[0], noise])) * 0.6  # crude highpass
    body = np.sin(2 * np.pi * 186 * t) * np.exp(-t / 0.055) * 0.5
    return (noise * np.exp(-t / 0.085) + body)


def hat(dur=0.07, open_=False):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.diff(np.concatenate([[0], rs.randn(n)]))
    return noise * np.exp(-t / (0.045 if open_ else 0.014)) * 0.55


def sub_hit(dur=1.2, f0=55.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (1 + 0.5 * np.exp(-t / 0.06))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.55)


def bass(f, dur, bite=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for k in range(1, 10):
        det = 1 + 0.0015 * np.sin(k * 2.1 + 0.7)
        s += np.sin(2 * np.pi * f * k * det * t + k * 0.4) / (k ** 1.05)
    s *= 0.30
    s += np.sin(2 * np.pi * f * t) * 0.55
    e = np.exp(-t / 0.30) * np.clip(t / 0.005, 0, 1)
    return np.tanh(s * e * bite * 1.1)


def pluck(f, dur=0.30, decay=0.10, bright=1.0, odd=False):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * f * t)
    ks = (1, 3, 5) if odd else (2, 3, 4, 5, 6)
    for k in ks:
        s += bright * np.sin(2 * np.pi * f * k * t) / (k ** 1.5)
    return s * np.exp(-t / decay) * np.clip(t / 0.0015, 0, 1) * 0.5


def pad(freqs, dur, attack=0.9, release=0.8, bright=1.0, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for f in freqs:
        for det in (-0.0055, 0.0, 0.0055):
            ph0 = rs.rand() * 2 * np.pi
            for k in (1, 2, 3, 4):
                s += np.sin(2 * np.pi * f * (1 + det) * k * t + ph0 * k) / (k ** 1.7)
    s /= (len(freqs) * 3)
    return s * env_ar(n, attack, release) * gain * bright


def blip(f0=2400.0, dur=0.10):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * np.exp(-t / 0.05)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.035) * 0.5


def riser(dur, f0=180.0, f1=1800.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (f1 / f0) ** (t / dur)
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) * 0.35 + np.sin(ph * 2.01) * 0.18
    noise = rs.randn(n) * 0.30
    amp = (t / dur) ** 2.2
    return (tone + noise) * amp


def impact(dur=2.4, f0=62.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (1 + 0.8 * np.exp(-t / 0.08))
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.75)
    crack = rs.randn(n) * np.exp(-t / 0.02) * 0.5
    air = rs.randn(n) * np.exp(-t / 0.5) * 0.12
    return np.tanh((body * 1.2 + crack + air) * 1.3)


# ---------------------------------------------------------------- harmony
# D minor. 4-bar loop: Dm | Bb | F | C   then   Dm | Bb | Gm | A
NOTE = {
    'D1': 36.71, 'Bb1': 29.14 * 2, 'F1': 43.65, 'C1': 32.70, 'G1': 24.50, 'A1': 27.50,
    'D2': 73.42, 'Bb2': 116.54, 'F2': 87.31, 'C2': 65.41, 'G2': 98.00, 'A2': 55.00,
    'D3': 146.83, 'F3': 174.61, 'A3': 220.00, 'Bb3': 233.08, 'C4': 261.63,
    'D4': 293.66, 'Eb4': 311.13, 'F4': 349.23, 'G4': 392.00, 'A4': 440.00,
    'Bb4': 466.16, 'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'F5': 698.46,
    'G5': 783.99, 'A5': 880.00, 'Bb5': 932.33, 'C6': 1046.50, 'D6': 1174.66,
}

CHORDS = [
    # root bass, pad voicing, arp tones
    (NOTE['D2'], [NOTE['D3'], NOTE['F3'], NOTE['A3'], NOTE['D4']], [NOTE['D4'], NOTE['F4'], NOTE['A4'], NOTE['D5']]),
    (NOTE['Bb2'], [NOTE['Bb2'], NOTE['D3'], NOTE['F3'], NOTE['Bb3']], [NOTE['F4'], NOTE['Bb4'], NOTE['D5'], NOTE['F5']]),
    (NOTE['F2'], [NOTE['F3'], NOTE['A3'], NOTE['C4'], NOTE['F4']], [NOTE['A4'], NOTE['C5'], NOTE['F5'], NOTE['A5']]),
    (NOTE['C2'], [NOTE['C4'], NOTE['F3'], NOTE['G3'] if 'G3' in NOTE else NOTE['F3'], NOTE['C4']], [NOTE['G4'], NOTE['C5'], NOTE['E5'], NOTE['G5']]),
    (NOTE['D2'], [NOTE['D3'], NOTE['F3'], NOTE['A3'], NOTE['D4']], [NOTE['D4'], NOTE['F4'], NOTE['A4'], NOTE['D5']]),
    (NOTE['Bb2'], [NOTE['Bb2'], NOTE['D3'], NOTE['F3'], NOTE['Bb3']], [NOTE['F4'], NOTE['Bb4'], NOTE['D5'], NOTE['F5']]),
    (NOTE['G2'], [NOTE['G2'] if False else NOTE['F3'], NOTE['Bb3'], NOTE['D4'], NOTE['G4']], [NOTE['G4'], NOTE['Bb4'], NOTE['D5'], NOTE['G5']]),
    (NOTE['A2'], [NOTE['A2'], NOTE['C4'], NOTE['E5'] / 2, NOTE['A3']], [NOTE['A4'], NOTE['C5'], NOTE['E5'], NOTE['A5']]),
]

# ---------------------------------------------------------------- energy map
def section(t):
    if t < 10.0:
        return 'intro'
    if t < 18.0:
        return 'boot'
    if t < 34.0:
        return 'dual'
    if t < 38.0:
        return 'break'
    if t < 46.0:
        return 'build'
    if t < 62.0:
        return 'climax'
    if t < 70.0:
        return 'strip'
    if t < 74.0:
        return 'lift'
    return 'tail'


DRUMS = {'intro': 0.0, 'boot': 0.55, 'dual': 1.0, 'break': 0.0, 'build': 1.0, 'climax': 1.15, 'strip': 0.25, 'lift': 0.9, 'tail': 0.0}
ARP = {'intro': 0.25, 'boot': 0.45, 'dual': 1.0, 'break': 0.3, 'build': 0.95, 'climax': 1.15, 'strip': 0.45, 'lift': 0.9, 'tail': 0.0}

n_bars = int(DUR / BAR) + 1
for bar in range(n_bars):
    t0 = bar * BAR
    ch = CHORDS[bar % 8]
    sec = section(t0)
    root, voicing, arp_tones = ch

    # ---- pad (whole bar, slight overlap)
    pad_gain = {'intro': 0.9, 'boot': 0.55, 'dual': 0.45, 'break': 1.15, 'build': 0.55,
                'climax': 0.62, 'strip': 0.95, 'lift': 0.5, 'tail': 0.8}[sec]
    add(pad(voicing, BAR + 0.6, attack=0.7 if sec != 'intro' else 1.6, release=0.7, gain=pad_gain),
        t0, pan=0.0, gain=0.26, wet=0.55)

    # ---- bass
    if sec in ('boot', 'dual', 'build', 'climax', 'lift'):
        step = 0.25 if sec in ('dual', 'climax') else 0.5
        k = 0
        while k * step < BAR - 1e-6:
            tt = t0 + k * step
            g = 0.62 if k % 4 == 0 else 0.42
            add(bass(root * (2 if sec == 'climax' and k % 8 >= 4 else 1), step * 0.95, bite=1.0 if sec != 'climax' else 1.2),
                tt, pan=0.0, gain=g * 0.55, wet=0.06)
            k += 1
    elif sec in ('intro', 'break', 'strip', 'tail'):
        add(bass(root, BAR * 0.95, bite=0.7), t0, pan=0.0, gain=0.34, wet=0.15)

    # ---- drums
    d = DRUMS[sec]
    if d > 0:
        for b in range(4):
            tb = t0 + b * BEAT
            heavy = (sec == 'climax') or (sec == 'dual')
            add(kick(0.45, 1.0 if heavy else 0.8), tb, gain=0.95 * d, wet=0.03)
            if sec in ('dual', 'build', 'climax', 'lift') and b in (1, 3):
                add(snare(), tb, pan=0.06, gain=0.42 * d, wet=0.18)
        sub = 4 if sec in ('climax', 'dual') else 2
        for s in range(sub * 4):
            ts = t0 + s * S16
            g = 0.30 if s % 4 == 0 else 0.14
            add(hat(0.07, open_=(s % 8 == 6)), ts, pan=-0.25 + 0.5 * ((s * 7) % 5) / 4,
                gain=g * d, wet=0.05)
        # off-beat ghost kick for drive
        if sec in ('climax', 'dual', 'build') and bar % 4 == 3:
            add(kick(0.3, 0.6), t0 + 3.5 * BEAT, gain=0.35 * d)

    # ---- arp
    a = ARP[sec]
    if a > 0:
        divisions = 16 if sec in ('dual', 'climax', 'build') else 8
        step = BAR / divisions
        for i in range(divisions):
            tone = arp_tones[i % 4]
            oct_up = 1 if (i // 4) % 2 == 0 else 2
            if sec == 'climax':
                oct_up = 1 if i % 8 < 4 else 2
            add(pluck(tone * oct_up, 0.26, decay=0.075 + 0.03 * a, bright=0.8),
                t0 + i * step, pan=-0.35 + 0.7 * (i % 4) / 3, gain=0.16 * a, wet=0.30)

    # ---- intro shimmer blips
    if sec == 'intro':
        for i in range(3):
            tb = t0 + rs.rand() * BAR
            add(blip(1800 + rs.rand() * 2600), tb, pan=rs.rand() * 1.6 - 0.8, gain=0.10, wet=0.6)

    # ---- climax counter line
    if sec == 'climax':
        lead = [NOTE['D5'], NOTE['F5'], NOTE['A5'], NOTE['C6'], NOTE['A5'], NOTE['F5']]
        for i, f in enumerate(lead):
            if (bar % 2) == 0:
                add(pluck(f, 0.5, decay=0.22, bright=1.1, odd=True), t0 + i * BEAT / 1.5,
                    pan=0.25, gain=0.11, wet=0.45)


# ---------------------------------------------------------------- accents
ACCENTS = {
    0.0: ('impact', 1.0), 5.0: ('sub', 0.8), 10.0: ('impact', 0.75),
    18.0: ('impact', 0.9), 23.0: ('impact', 0.6), 34.0: ('impact', 0.8),
    38.0: ('sub', 0.7), 46.0: ('impact', 1.15), 54.0: ('impact', 0.85),
    62.0: ('impact', 0.75), 74.0: ('impact', 1.0),
}
for t, (kind, g) in ACCENTS.items():
    if kind == 'impact':
        add(impact(2.6), t, gain=0.40 * g, wet=0.45)
        add(kick(0.6, 1.2), t, gain=0.55 * g)
    else:
        add(sub_hit(1.4, 42.0), t, gain=0.5 * g, wet=0.2)

# risers
for (s, e, g) in [(7.4, 10.0, 0.30), (14.2, 18.0, 0.26), (31.6, 34.0, 0.30),
                  (42.0, 46.0, 0.34), (58.6, 62.0, 0.22), (70.4, 74.0, 0.40)]:
    r = riser(e - s)
    add(r, s, gain=g, wet=0.3)

# downlifter into the break
add(riser(2.0, 1200, 90)[::-1] * 0.5, 33.2, gain=0.25, wet=0.4)

# final tail: a long chord + decay
tail_t = 74.0
tail_dur = DUR - tail_t
add(pad([NOTE['D3'], NOTE['F3'], NOTE['A3'], NOTE['D4'], NOTE['A4']], tail_dur,
        attack=0.05, release=3.2, gain=0.9), tail_t, gain=0.5, wet=0.7)
add(sub_hit(3.4, 36.7), tail_t, gain=0.5, wet=0.3)

# ---------------------------------------------------------------- reverb
def reverb(x, decay=0.42, pre=0.012, size=1.0):
    ir_n = int(3.0 * SR)
    t = np.arange(ir_n) / SR
    ir = rs.randn(ir_n) * np.exp(-t / decay)
    ir[: int(pre * SR)] = 0
    # soften the impulse: gentle lowpass by convolution with a short window
    w = np.hanning(64)
    ir = np.convolve(ir, w / w.sum(), mode='same')
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    n = 1 << int(np.ceil(np.log2(len(x) + ir_n)))
    y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)]
    return y * size


wet = reverb(SEND)
L = L + wet * 0.9
R = R + wet * 0.9

# ---------------------------------------------------------------- master
def master(x):
    x = np.tanh(x * 0.92) * 0.92
    peak = np.max(np.abs(x)) + 1e-9
    return x / peak * 0.90

L, R = master(L), master(R)
stereo = np.stack([L, R], axis=1)
pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')

out = __file__.rsplit('/', 2)[0] + '/public/score.wav'
with wave.open(out, 'wb') as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes(pcm.tobytes())
print('wrote', out, pcm.shape, round(len(pcm) / SR, 3), 's')
