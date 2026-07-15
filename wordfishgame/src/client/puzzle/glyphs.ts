import Phaser from 'phaser';
import { PALETTE } from '../theme';

/**
 * Tiny drawn glyphs shared by the menu badges, buttons and win card. Emoji are deliberately
 * avoided on-canvas — they only render where a colour-emoji font happens to be installed,
 * which isn't guaranteed across Reddit's webviews — so every little icon here is built from
 * Graphics primitives instead. Each helper returns a Graphics object positioned at (x, y)
 * in whatever container it's added to.
 */

/** A small Memphis flame (red teardrop with a warm inner highlight) — the streak marker. */
export function drawFlame(scene: Phaser.Scene, x: number, y: number): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.setPosition(x, y);
  g.fillStyle(PALETTE.red, 1);
  g.fillCircle(0, 3, 5);
  g.fillTriangle(-5, 3, 5, 3, 0, -9);
  g.fillStyle(0xfff2c4, 1); // cream inner flame for a hint of depth on the yellow pill
  g.fillCircle(0, 4, 2.4);
  g.fillTriangle(-2.4, 4, 2.4, 4, 0, -2);
  return g;
}

/** A little left-facing fish (body, tail, eye) — marks "players who caught this puzzle". */
export function drawFish(
  scene: Phaser.Scene,
  x: number,
  y: number,
  bodyColor: number = PALETTE.cyan
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.setPosition(x, y);
  g.fillStyle(bodyColor, 1);
  g.fillEllipse(-1, 0, 11, 7.5);
  g.fillTriangle(3.5, 0, 8, -4, 8, 4); // tail
  g.fillStyle(PALETTE.ink, 1);
  g.fillCircle(-3.5, -1, 1.2); // eye
  return g;
}

/** A green "done" disc with a white check — marks a puzzle this player has already solved. */
export function drawSolvedTick(
  scene: Phaser.Scene,
  x: number,
  y: number,
  r = 13
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.setPosition(x, y);
  g.fillStyle(PALETTE.green, 1);
  g.fillCircle(0, 0, r);
  g.lineStyle(3, PALETTE.ink, 1);
  g.strokeCircle(0, 0, r);
  g.lineStyle(3.5, 0xffffff, 1);
  g.beginPath();
  g.moveTo(-r * 0.42, 0);
  g.lineTo(-r * 0.1, r * 0.32);
  g.lineTo(r * 0.45, -r * 0.32);
  g.strokePath();
  return g;
}

/** "999", "1.2K", "34K", "1.2M" — solver counts kept short enough for a tiny chip. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${Math.floor(n / 100) / 10}K`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}K`;
  return `${Math.floor(n / 100_000) / 10}M`;
}
