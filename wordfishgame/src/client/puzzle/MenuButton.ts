import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

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
