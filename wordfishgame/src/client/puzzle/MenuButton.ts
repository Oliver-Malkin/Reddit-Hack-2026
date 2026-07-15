import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import { drawFish, drawSolvedTick, formatCount } from './glyphs';

/** Small difficulty indicator drawn under the label: `filled` of `total` dots lit. */
export type MenuButtonPips = { filled: number; total: number; color: number };

export type MenuButtonOptions = {
  width: number;
  height: number;
  label: string;
  /** Face colour of the pill. */
  fill: number;
  /** Label colour (CSS). Defaults to ink. */
  textColor?: string;
  /** Optional difficulty pips under the label. */
  pips?: MenuButtonPips;
  onTap: () => void;
};

// A pressed face shifts down-right into its collapsed shadow — same tactile language as
// the on-screen keys, word tiles and icon buttons.
const PRESS_DX = 2;
const PRESS_DY = 3;

/**
 * A big chunky Memphis call-to-action button: coloured pill, thick ink border, offset
 * shadow, a bold label and optional difficulty pips. Presses in like every other control
 * in the game (shadow collapses, face + content shift down-right) so the whole UI shares
 * one tactile feel. Used for the main-menu difficulty and tutorial buttons.
 */
export class MenuButton extends Phaser.GameObjects.Container {
  private boxW: number;
  private boxH: number;
  private fill: number;
  private pips: MenuButtonPips | null;
  private bg: Phaser.GameObjects.Graphics;
  private content: Phaser.GameObjects.Container;
  private onTap: () => void;
  private pressed = false;
  private enabled = true;
  // Optional solve-state decorations (see setSolved / setSolvers). Both live inside `content`
  // so they press-shift with the face — the whole button stays one tactile object.
  private solvedTick: Phaser.GameObjects.Container | null = null;
  private solversChip: Phaser.GameObjects.Container | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number, opts: MenuButtonOptions) {
    super(scene, x, y);
    this.boxW = opts.width;
    this.boxH = opts.height;
    this.fill = opts.fill;
    this.pips = opts.pips ?? null;
    this.onTap = opts.onTap;

    this.bg = scene.add.graphics();
    this.add(this.bg);

    // Content (label + pips) rides in its own container so it can shift as one on press.
    this.content = scene.add.container(0, 0);
    const hasPips = this.pips !== null;
    const label = scene.add.text(0, hasPips ? -8 : 0, opts.label, {
      fontFamily: UI_FONT,
      fontSize: `${Math.round(this.boxH * 0.34)}px`,
      fontStyle: '900',
      color: opts.textColor ?? '#1c1c1c',
    });
    label.setOrigin(0.5);
    this.content.add(label);
    if (this.pips) {
      const pg = scene.add.graphics();
      this.drawPips(pg, this.pips, this.boxH * 0.5 - 13);
      this.content.add(pg);
    }
    this.add(this.content);

    this.redraw();

    this.setSize(this.boxW, this.boxH);
    // Phaser measures a Container's hit-area local point from its top-left, so a rect at
    // (0,0,w,h) covers the centred visual box (same gotcha handled in WordTile/IconButton).
    this.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, this.boxW, this.boxH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    this.on('pointerdown', () => {
      if (!this.enabled) return;
      this.setPressed(true);
      this.onTap();
    });
    this.on('pointerup', () => this.setPressed(false));
    this.on('pointerout', () => this.setPressed(false));

    scene.add.existing(this);
  }

  /** Show (or clear) the green "already solved" tick riding the button's top-right corner —
   *  today's catch stays visibly caught when the player comes back to the menu. `animate`
   *  springs it in, for when the state lands after the button is already on screen. */
  setSolved(solved: boolean, animate = false) {
    if (!solved) {
      this.solvedTick?.destroy();
      this.solvedTick = null;
      return;
    }
    if (this.solvedTick) return;
    const tick = this.scene.add.container(this.boxW / 2 - 6, -this.boxH / 2 + 6);
    tick.add(drawSolvedTick(this.scene, 0, 0, 13));
    this.content.add(tick);
    this.solvedTick = tick;
    if (animate) {
      tick.setScale(0);
      this.scene.tweens.add({ targets: tick, scale: 1, duration: 320, ease: 'Back.easeOut' });
    }
  }

  /** Show how many distinct players have solved this puzzle — a mini white pill with a drawn
   *  fish, sitting astride the button's bottom-right edge. Hidden for null (unknown/offline)
   *  and for 0: "nobody has caught this yet" is better left unsaid than shown. */
  setSolvers(count: number | null, animate = false) {
    this.solversChip?.destroy();
    this.solversChip = null;
    if (count == null || count <= 0) return;

    const scene = this.scene;
    const label = scene.add.text(0, 0, formatCount(count), {
      fontFamily: UI_FONT,
      fontSize: '11px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    label.setOrigin(0, 0.5);

    const fishW = 14;
    const gap = 4;
    const padX = 8;
    const h = 21;
    const w = padX + fishW + gap + Math.round(label.width) + padX;
    // Astride the bottom border, tucked toward the right corner (the tick owns the top-right).
    const chip = scene.add.container(this.boxW / 2 - w / 2 - 14, this.boxH / 2);

    const g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    chip.add(g);
    chip.add(drawFish(scene, -w / 2 + padX + fishW / 2, 0));
    label.setPosition(-w / 2 + padX + fishW + gap, 0);
    chip.add(label);

    this.content.add(chip);
    this.solversChip = chip;
    if (animate) {
      chip.setScale(0);
      this.scene.tweens.add({ targets: chip, scale: 1, duration: 320, ease: 'Back.easeOut' });
    }
  }

  /** Grey out and stop responding (e.g. while a modal is open or during a transition). */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.setPressed(false);
    this.setAlpha(enabled ? 1 : 0.4);
  }

  private setPressed(pressed: boolean) {
    if (this.pressed === pressed) return;
    this.pressed = pressed;
    this.redraw();
    this.content.setPosition(pressed ? PRESS_DX : 0, pressed ? PRESS_DY : 0);
  }

  private redraw() {
    const w = this.boxW;
    const h = this.boxH;
    const r = Math.min(h / 2, 22);
    const g = this.bg;
    g.clear();
    if (!this.pressed) {
      g.fillStyle(PALETTE.ink, 0.22);
      g.fillRoundedRect(-w / 2 + 5, -h / 2 + 7, w, h, r);
    }
    const dx = this.pressed ? PRESS_DX : 0;
    const dy = this.pressed ? PRESS_DY : 0;
    g.fillStyle(this.fill, 1);
    g.fillRoundedRect(-w / 2 + dx, -h / 2 + dy, w, h, r);
    g.lineStyle(5, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2 + dx, -h / 2 + dy, w, h, r);
  }

  private drawPips(g: Phaser.GameObjects.Graphics, pips: MenuButtonPips, y: number) {
    const rad = 3.5;
    const gap = 13;
    const startX = -((pips.total - 1) * gap) / 2;
    for (let i = 0; i < pips.total; i++) {
      const px = startX + i * gap;
      if (i < pips.filled) {
        g.fillStyle(pips.color, 1);
        g.fillCircle(px, y, rad);
      } else {
        g.lineStyle(2, pips.color, 0.45);
        g.strokeCircle(px, y, rad);
      }
    }
  }
}
