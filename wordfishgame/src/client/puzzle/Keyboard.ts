import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const GAP = 6;
const PANEL_PAD = 10;
const PANEL_RADIUS = 14;
const BOTTOM_MARGIN = 10;
const KEY_RADIUS = 8;
const MAX_KEY_W = 44;
const MAX_PANEL_W = 540;
// A pressed key's face shifts down-right into its (collapsed) shadow.
const PRESS_DX = 2;
const PRESS_DY = 3;

export type KeyboardHandlers = {
  /** A key was tapped: 'A'–'Z' or 'Backspace'. */
  onKey: (key: string) => void;
  /** The keyboard opened or minimised — re-flow anything that shares the space. */
  onToggle: () => void;
};

type KeyView = {
  key: string;
  bg: Phaser.GameObjects.Graphics;
  face: Phaser.GameObjects.Container;
  baseX: number;
  baseY: number;
  w: number;
  h: number;
  pressed: boolean;
};

/**
 * Memphis-styled on-screen keyboard: three QWERTY rows of chunky white keys with ink
 * borders and offset shadows, pinned to the bottom of the canvas. It exists because a
 * phone webview has no physical keys and never shows the native soft keyboard for a
 * canvas — but it stays on desktop too, where physical presses light up the matching
 * key via flashKey(). Keys press IN (shadow collapses, face shifts, yellow flash) for
 * tactile feel. The ˅ button minimises it to a small corner tab so it never has to
 * hog a small webview; reservedHeight() tells the scene how much bottom space to keep.
 */
export class OnScreenKeyboard extends Phaser.GameObjects.Container {
  private handlers: KeyboardHandlers;
  private keys: KeyView[] = [];
  private restoreTab: Phaser.GameObjects.Container;
  private panelW = 0;
  private panelH = 0;
  private minimized = false;

  constructor(scene: Phaser.Scene, handlers: KeyboardHandlers) {
    super(scene, 0, 0);
    this.handlers = handlers;
    scene.add.existing(this);
    this.setDepth(95);
    this.restoreTab = this.buildRestoreTab();
    this.layout();
  }

  /** Vertical space the open keyboard claims at the bottom of the canvas. */
  reservedHeight(): number {
    return this.minimized ? 0 : this.panelH + BOTTOM_MARGIN * 2;
  }

  /** Rebuild the keys for the current canvas size and pin to the bottom. Call on resize. */
  layout() {
    this.removeAll(true);
    this.keys = [];
    const scene = this.scene;
    const W = scene.scale.width;
    const H = scene.scale.height;

    // Size keys off the 10-unit top row; capped so desktop keys stay compact.
    const avail = Math.min(W - 12, MAX_PANEL_W);
    const unit = Math.min(MAX_KEY_W, (avail - PANEL_PAD * 2 - GAP * 9) / 10);
    const keyH = Phaser.Math.Clamp(unit * 1.3, 32, 50);
    this.panelW = PANEL_PAD * 2 + unit * 10 + GAP * 9;
    this.panelH = PANEL_PAD * 2 + keyH * 3 + GAP * 2;

    // Card-style panel: offset shadow, near-white fill, thick ink border.
    const panel = scene.add.graphics();
    panel.fillStyle(PALETTE.ink, 0.16);
    panel.fillRoundedRect(5, 6, this.panelW, this.panelH, PANEL_RADIUS);
    panel.fillStyle(0xffffff, 0.93);
    panel.fillRoundedRect(0, 0, this.panelW, this.panelH, PANEL_RADIUS);
    panel.lineStyle(4, PALETTE.ink, 1);
    panel.strokeRoundedRect(0, 0, this.panelW, this.panelH, PANEL_RADIUS);
    this.add(panel);

    // Catch presses that land between keys so they don't fall through to the scene
    // (which would blur the tile being typed into).
    const panelHit = scene.add.container(this.panelW / 2, this.panelH / 2);
    panelHit.setSize(this.panelW, this.panelH);
    panelHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, this.panelW, this.panelH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });
    this.add(panelHit);

    ROWS.forEach((row, r) => {
      const y = PANEL_PAD + keyH / 2 + r * (keyH + GAP);
      // The bottom row carries a 1.5-unit backspace after the letters; centre each
      // row's full width like a real keyboard.
      const units = row.length + (r === 2 ? 1.5 : 0);
      const gaps = row.length - 1 + (r === 2 ? 1 : 0);
      let x = (this.panelW - (units * unit + gaps * GAP)) / 2;
      for (const ch of row) {
        this.makeKey(x + unit / 2, y, unit, keyH, ch);
        x += unit + GAP;
      }
      if (r === 2) this.makeKey(x + (unit * 1.5) / 2, y, unit * 1.5, keyH, 'Backspace');
    });

    this.buildMinimizeButton();

    this.setPosition((W - this.panelW) / 2, this.minimized ? H + 24 : this.openY());
    this.restoreTab.setPosition(W - 46, H - 32);
    this.restoreTab.setVisible(this.minimized);
  }

  /** Light up a key as if tapped — mirrors physical keyboard presses on screen. */
  flashKey(key: string) {
    const norm = key.length === 1 ? key.toUpperCase() : key;
    const view = this.keys.find((k) => k.key === norm);
    if (!view || view.pressed) return;
    this.setPressed(view, true);
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 110,
      onComplete: () => this.setPressed(view, false),
    });
  }

  /** Slide the keyboard away to a corner tab, or bring it back. */
  setMinimized(min: boolean) {
    if (this.minimized === min) return;
    this.minimized = min;
    const scene = this.scene;
    scene.tweens.killTweensOf(this);
    if (min) {
      scene.tweens.add({
        targets: this,
        y: scene.scale.height + 24,
        duration: 240,
        ease: 'Quad.easeIn',
        onComplete: () => {
          this.restoreTab.setVisible(true);
          this.restoreTab.setScale(0);
          scene.tweens.add({
            targets: this.restoreTab,
            scaleX: 1,
            scaleY: 1,
            duration: 220,
            ease: 'Back.easeOut',
          });
        },
      });
    } else {
      this.restoreTab.setVisible(false);
      scene.tweens.add({ targets: this, y: this.openY(), duration: 280, ease: 'Back.easeOut' });
    }
    this.handlers.onToggle();
  }

  private openY(): number {
    return this.scene.scale.height - this.panelH - BOTTOM_MARGIN;
  }

  private makeKey(cx: number, cy: number, w: number, h: number, key: string) {
    const scene = this.scene;
    const bg = scene.add.graphics();
    bg.setPosition(cx, cy);
    this.add(bg);

    // The face (letter or glyph) lives in its own container so pressing can shift it.
    const face = scene.add.container(cx, cy);
    if (key === 'Backspace') {
      face.add(this.makeBackspaceGlyph());
    } else {
      const label = scene.add.text(0, 0, key, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(h * 0.42)}px`,
        fontStyle: '900',
        color: '#1c1c1c',
      });
      label.setOrigin(0.5);
      face.add(label);
    }
    this.add(face);

    const view: KeyView = { key, bg, face, baseX: cx, baseY: cy, w, h, pressed: false };
    this.drawKey(view);

    // Hit zone (containers hit-test from their top-left, so the rect is (0,0,w,h)).
    const hit = scene.add.container(cx, cy);
    hit.setSize(w, h);
    hit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    hit.on('pointerdown', () => {
      this.setPressed(view, true);
      this.handlers.onKey(key);
    });
    hit.on('pointerup', () => this.setPressed(view, false));
    hit.on('pointerout', () => this.setPressed(view, false));
    this.add(hit);

    this.keys.push(view);
  }

  private drawKey(view: KeyView) {
    const { bg, w, h, pressed } = view;
    bg.clear();
    if (!pressed) {
      bg.fillStyle(PALETTE.ink, 0.18);
      bg.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, KEY_RADIUS);
    }
    const dx = pressed ? PRESS_DX : 0;
    const dy = pressed ? PRESS_DY : 0;
    bg.fillStyle(pressed ? PALETTE.yellow : 0xffffff, 1);
    bg.fillRoundedRect(-w / 2 + dx, -h / 2 + dy, w, h, KEY_RADIUS);
    bg.lineStyle(3, PALETTE.ink, 1);
    bg.strokeRoundedRect(-w / 2 + dx, -h / 2 + dy, w, h, KEY_RADIUS);
  }

  private setPressed(view: KeyView, pressed: boolean) {
    if (view.pressed === pressed) return;
    view.pressed = pressed;
    this.drawKey(view);
    view.face.setPosition(
      view.baseX + (pressed ? PRESS_DX : 0),
      view.baseY + (pressed ? PRESS_DY : 0),
    );
  }

  /** Drawn (not a font glyph) so it renders identically on every device. */
  private makeBackspaceGlyph(): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics();
    g.lineStyle(3, PALETTE.ink, 1);
    g.beginPath();
    g.moveTo(-10, 0);
    g.lineTo(-3, -7);
    g.lineTo(10, -7);
    g.lineTo(10, 7);
    g.lineTo(-3, 7);
    g.closePath();
    g.strokePath();
    g.lineStyle(2.5, PALETTE.ink, 1);
    g.lineBetween(0, -3, 6, 3);
    g.lineBetween(6, -3, 0, 3);
    return g;
  }

  private buildMinimizeButton() {
    const scene = this.scene;
    // White disc with a ˅ chevron, straddling the panel's top-right corner (same
    // style as the win popup's close button).
    const cx = this.panelW - 20;
    const cy = 0;
    const g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(cx, cy, 13);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeCircle(cx, cy, 13);
    g.beginPath();
    g.moveTo(cx - 5, cy - 2);
    g.lineTo(cx, cy + 3);
    g.lineTo(cx + 5, cy - 2);
    g.strokePath();
    this.add(g);

    const hit = scene.add.container(cx, cy);
    hit.setSize(34, 34);
    hit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, 34, 34),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    hit.on('pointerdown', () => this.setMinimized(true));
    this.add(hit);
  }

  /** Small bottom-right pill with a mini-keyboard glyph; tap to bring the keys back. */
  private buildRestoreTab(): Phaser.GameObjects.Container {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const w = 58;
    const h = 36;
    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.18);
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, 10);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);
    // Mini keyboard: three key squares over a space bar.
    g.fillStyle(PALETTE.ink, 1);
    for (let i = 0; i < 3; i++) g.fillRoundedRect(-14.5 + i * 11, -9, 7, 7, 2);
    g.fillRoundedRect(-14.5, 2, 29, 7, 2);
    c.add(g);

    c.setSize(w, h);
    c.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    c.on('pointerdown', () => this.setMinimized(false));
    c.setDepth(95);
    c.setVisible(false);
    return c;
  }
}
