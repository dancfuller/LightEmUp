// ─── Thunder Sound Synth ─────────────────────────────────────────────────────

let _thunderCtx = null;

function playThunder() {
  // Reuse or create AudioContext (browsers limit the number of contexts).
  if (!_thunderCtx || _thunderCtx.state === "closed") {
    _thunderCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const ctx = _thunderCtx;
  if (ctx.state === "suspended") ctx.resume();

  const duration = 1.5 + Math.random() * 2.5;
  const sampleRate = ctx.sampleRate;
  const numSamples = Math.floor(duration * sampleRate);
  const buffer = ctx.createBuffer(1, numSamples, sampleRate);
  const data = buffer.getChannelData(0);

  // Brown noise with multi-layer envelope: sharp crack + long rumble.
  let last = 0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const crack = Math.exp(-t * 10) * 0.7;
    const rumble = Math.exp(-t * 1.0) * (1.0 + 0.4 * Math.sin(t * 2.3));
    const envelope = crack + rumble;
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * envelope * 35;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 120 + Math.random() * 100;

  const gain = ctx.createGain();
  gain.gain.value = 0.8;

  source.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

// ─── Fart Sounds ─────────────────────────────────────────────────────────────

// 20 real fart sound MP3s served from /sounds/farts/, preloaded on page load.
const FART_FILES = [
  "fart-01.mp3", "fart-02.mp3", "fart-03.mp3", "fart-04.mp3",
  "fart-05.mp3", "fart-06.mp3", "fart-07.mp3", "fart-08.mp3",
  "fart-squeak-01.mp3", "fart-squeak-02.mp3", "fart-squeak-03.mp3",
  "fart-big.mp3", "fart-bomb.mp3", "fart-dry.mp3", "fart-echo.mp3",
  "fart-epic.mp3", "fart-long-wet.mp3", "fart-realistic.mp3",
  "fart-squeak-reverb.mp3", "fart-wet-slow.mp3",
];
const _fartAudios = FART_FILES.map(f => {
  const a = new Audio(`/sounds/farts/${f}`);
  a.preload = "auto";
  return a;
});

function playFart() {
  const audio = _fartAudios[Math.floor(Math.random() * _fartAudios.length)];
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
