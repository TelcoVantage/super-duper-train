/**
 * Tiny Web Audio beeper: no audio assets to host, works inside the Genesys
 * Cloud iframe. Browsers block sound until the user has interacted with the
 * page, so `unlock()` is wired to the first click/keypress in the panel.
 */
let ctx = null;
let unlocked = false;

function getContext() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export async function unlock() {
  const c = getContext();
  if (!c) return false;
  try {
    if (c.state === 'suspended') await c.resume();
    unlocked = c.state === 'running';
  } catch {
    unlocked = false;
  }
  return unlocked;
}

export function isUnlocked() {
  return unlocked && ctx?.state === 'running';
}

function tone(c, { freq, start, duration, gain = 0.18, type = 'sine' }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/**
 * @param {'warn'|'critical'|'test'} level
 */
export function play(level) {
  const c = getContext();
  if (!c || c.state !== 'running') return false;
  const t = c.currentTime;
  if (level === 'critical') {
    tone(c, { freq: 988, start: t, duration: 0.14 });
    tone(c, { freq: 988, start: t + 0.18, duration: 0.14 });
    tone(c, { freq: 1319, start: t + 0.36, duration: 0.28 });
  } else {
    tone(c, { freq: 880, start: t, duration: 0.16 });
    tone(c, { freq: 1175, start: t + 0.2, duration: 0.22 });
  }
  return true;
}
