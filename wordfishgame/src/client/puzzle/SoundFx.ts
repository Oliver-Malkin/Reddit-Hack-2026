/**
 * Tiny procedural sound effects via the Web Audio API — no audio files needed.
 * Every sound is synthesized from oscillators with short gain envelopes, tuned to
 * feel tactile rather than musical (except the win jingle, which is proudly musical).
 *
 * The AudioContext is created lazily on first use; since every call site is inside a
 * user gesture (keypress, pointer), this also satisfies browser autoplay policies.
 * If audio is unavailable (denied context, SSR, etc.) every method is a silent no-op.
 */
export class SoundFx {
  private ctx: AudioContext | null = null;
  private failed = false;
  /** Master volume, 0..1. Kept low — these are accents, not a soundtrack. */
  volume = 0.5;

  private ensure(): AudioContext | null {
    if (this.failed) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        this.failed = true;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * One enveloped oscillator note.
   * @param freq start frequency (Hz); @param glideTo optional end frequency
   * @param at offset from now (s); @param dur length (s); @param peak gain 0..1
   */
  private note(
    type: OscillatorType,
    freq: number,
    dur: number,
    peak: number,
    at = 0,
    glideTo?: number
  ) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(glideTo, 1), t0 + dur);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak * this.volume, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Typewriter-ish clack for entering a letter. */
  tap() {
    this.note('square', 1750, 0.045, 0.055, 0, 900);
    this.note('sine', 320, 0.05, 0.09);
  }

  /** Softer, lower clack for backspace/delete. */
  erase() {
    this.note('square', 700, 0.05, 0.05, 0, 420);
  }

  /** Picking a tile up. */
  grab() {
    this.note('sine', 280, 0.09, 0.12, 0, 480);
  }

  /** Setting a tile down. */
  drop() {
    this.note('sine', 480, 0.1, 0.12, 0, 260);
  }

  /** Full-but-wrong answer: a flat double-buzz. */
  wrong() {
    this.note('sawtooth', 155, 0.14, 0.1);
    this.note('sawtooth', 116, 0.2, 0.1, 0.12);
  }

  /** Win jingle: quick major arpeggio topped with a sparkle octave. */
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      this.note('triangle', freq, 0.28, 0.14, i * 0.09);
    });
    this.note('triangle', 1318.5, 0.5, 0.1, notes.length * 0.09); // E6 tail
    this.note('sine', 261.63, 0.6, 0.08, notes.length * 0.09); // C4 warmth
  }

  /** Small confirmation chime (e.g. share text copied). */
  chime() {
    this.note('triangle', 880, 0.12, 0.1);
    this.note('triangle', 1174.66, 0.18, 0.1, 0.07);
  }
}
