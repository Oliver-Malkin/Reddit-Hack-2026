import Phaser from 'phaser';
import { PALETTE, UI_FONT, cssColor } from '../theme';

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
// Left/top bleed baked into the texture so the panel's 4px border and key shadows aren't
// cropped; the panel is drawn at (0,0) in panel space and this pad sits outside it.
const TEX_PAD = 6;

/**
 * Extra clearance above the canvas bottom for webviews that extend behind browser chrome.
 * Reddit's mobile-web expanded webview is sized with the LARGE viewport (100vh of the host
 * page), so its bottom ~60px sits behind the browser's retractable URL bar — and that clip
 * is invisible from inside the iframe (100dvh here just measures the iframe itself). Pinning
 * the keys flush to the canvas bottom put the whole Z row under the bar. Heuristic: embedded
 * in an iframe AND a touch device → lift everything bottom-anchored clear. Desktop reddit
 * (mouse), the native app-style direct webview and the local vite preview all get 0.
 */
function bottomSafeInset(): number {
  let embedded: boolean;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true; // cross-origin parent blocked the check — definitely an iframe
  }
  const touch =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : 'ontouchstart' in window;
  return embedded && touch ? 64 : 0;
}
// Supersample the baked panel so it stays crisp on high-DPI (retina / phone) screens.
const TEX_RES = 2;

export type KeyboardHandlers = {
  /** A key was tapped: 'A'–'Z' or 'Backspace'. */
  onKey: (key: string) => void;
  /** The keyboard opened or minimised — re-flow anything that shares the space. */
  onToggle: () => void;
};

/** A key's hit rectangle + centre, in panel-local space. No GameObjects — the whole key face
 *  (box, border, letter) is baked into the shared panel texture; this is just geometry. */
type KeyRect = {
  key: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
};

/**
 * Memphis-styled on-screen keyboard: three QWERTY rows of chunky white keys with ink
 * borders and offset shadows, pinned to the bottom of the canvas. It exists because a
 * phone webview has no physical keys and never shows the native soft keyboard for a
 * canvas — but it stays on desktop too, where physical presses light up the matching
 * key via flashKey().
 *
 * Rendering: the entire static keyboard is baked once into a single canvas texture (one
 * draw call) rather than ~28 Graphics+Text pairs (~59 draw calls, which profiling showed
 * was the app's single biggest render cost). Taps are hit-tested by math against the stored
 * key rects, and the pressed-in yellow face is a single reused overlay shown only while a
 * key is held. The ˅ button minimises it to a small corner tab; reservedHeight() tells the
 * scene how much bottom space to keep.
 */
export class OnScreenKeyboard extends Phaser.GameObjects.Container {
  private handlers: KeyboardHandlers;
  private keyRects: KeyRect[] = [];
  private restoreTab: Phaser.GameObjects.Container;
  // Press-feedback overlay, reused for whichever key is currently held (0 draws when idle).
  private pressG!: Phaser.GameObjects.Graphics;
  private pressLabel!: Phaser.GameObjects.Text;
  private keyH = 40;
  private panelW = 0;
  private panelH = 0;
  private minimized = false;
  // Baked-panel texture key, unique PER SCENE. Each scene has its own keyboard, and the
  // texture manager is game-wide — a shared key let one scene's re-bake destroy the texture
  // another scene's keyboard image still pointed at, which rendered a dead texture (blank
  // keyboard, and intermittently a hard render freeze).
  private texKey: string;

  constructor(scene: Phaser.Scene, handlers: KeyboardHandlers) {
    super(scene, 0, 0);
    this.handlers = handlers;
    this.texKey = `osk-panel-${scene.scene.key}`;
    scene.add.existing(this);
    this.setDepth(95);
    this.restoreTab = this.buildRestoreTab();

    // Releasing anywhere clears the held key — wired once (layout() runs many times).
    const release = () => this.releaseKeys();
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);

    this.layout();
  }

  /** Vertical space the open keyboard claims at the bottom of the canvas. */
  reservedHeight(): number {
    return this.minimized ? 0 : this.panelH + BOTTOM_MARGIN * 2 + bottomSafeInset();
  }

  /** Rebuild the keys for the current canvas size and pin to the bottom. Call on resize. */
  layout() {
    this.removeAll(true);
    this.keyRects = [];
    const scene = this.scene;
    const W = scene.scale.width;
    const H = scene.scale.height;

    // Size keys off the 10-unit top row; capped so desktop keys stay compact.
    const avail = Math.min(W - 12, MAX_PANEL_W);
    const unit = Math.min(MAX_KEY_W, (avail - PANEL_PAD * 2 - GAP * 9) / 10);
    this.keyH = Phaser.Math.Clamp(unit * 1.3, 32, 50);
    this.panelW = PANEL_PAD * 2 + unit * 10 + GAP * 9;
    this.panelH = PANEL_PAD * 2 + this.keyH * 3 + GAP * 2;

    // Compute every key's rect (panel-local space) up front so the same geometry drives the
    // bake, the hit test and the press overlay.
    ROWS.forEach((row, r) => {
      const y = PANEL_PAD + this.keyH / 2 + r * (this.keyH + GAP);
      const units = row.length + (r === 2 ? 1.5 : 0);
      const gaps = row.length - 1 + (r === 2 ? 1 : 0);
      let x = (this.panelW - (units * unit + gaps * GAP)) / 2;
      for (const ch of row) {
        this.keyRects.push({ key: ch, cx: x + unit / 2, cy: y, w: unit, h: this.keyH });
        x += unit + GAP;
      }
      if (r === 2) {
        this.keyRects.push({ key: 'Backspace', cx: x + (unit * 1.5) / 2, cy: y, w: unit * 1.5, h: this.keyH });
      }
    });

    // The whole panel + keys as one baked image (origin shifted by TEX_PAD so panel-local
    // (0,0) lands on the container origin, keeping child coords in plain panel space).
    this.bakePanelTexture();
    // Texture is baked at TEX_RES×; display at 1/TEX_RES so it lands at true panel size.
    const image = scene.add.image(-TEX_PAD, -TEX_PAD, this.texKey).setOrigin(0, 0);
    image.setScale(1 / TEX_RES);
    this.add(image);

    // Catch presses anywhere on the panel and route them to a key by hit-testing the rects.
    const panelHit = scene.add.container(this.panelW / 2, this.panelH / 2);
    panelHit.setSize(this.panelW, this.panelH);
    panelHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, this.panelW, this.panelH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });
    panelHit.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.onPanelDown(pointer));
    this.add(panelHit);

    // Press-feedback overlay: a yellow face + shifted letter, hidden until a key is held.
    this.pressG = scene.add.graphics().setVisible(false);
    this.add(this.pressG);
    this.pressLabel = scene.add
      .text(0, 0, '', {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(this.keyH * 0.42)}px`,
        fontStyle: '900',
        color: '#1c1c1c',
      })
      .setOrigin(0.5)
      .setVisible(false);
    this.add(this.pressLabel);

    this.buildMinimizeButton();

    this.setPosition((W - this.panelW) / 2, this.minimized ? H + 24 : this.openY());
    this.restoreTab.setPosition(W - 46, H - 32 - bottomSafeInset());
    this.restoreTab.setVisible(this.minimized);
  }

  /** Light up a key as if tapped — mirrors physical keyboard presses on screen. */
  flashKey(key: string) {
    const norm = key.length === 1 ? key.toUpperCase() : key;
    const rect = this.keyRects.find((k) => k.key === norm);
    if (!rect) return;
    this.pressKey(rect);
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 110,
      onComplete: () => this.releaseKeys(),
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
    return this.scene.scale.height - this.panelH - BOTTOM_MARGIN - bottomSafeInset();
  }

  /** Map a pointer to the key under it (panel-local coords) and fire it. */
  private onPanelDown(pointer: Phaser.Input.Pointer) {
    const lx = pointer.worldX - this.x;
    const ly = pointer.worldY - this.y;
    const rect = this.keyRects.find(
      (k) => Math.abs(lx - k.cx) <= k.w / 2 && Math.abs(ly - k.cy) <= k.h / 2
    );
    if (!rect) return;
    this.pressKey(rect);
    this.handlers.onKey(rect.key);
  }

  /** Show the pressed-in yellow face for a key via the shared overlay. */
  private pressKey(rect: KeyRect) {
    const x = rect.cx - rect.w / 2 + PRESS_DX;
    const y = rect.cy - rect.h / 2 + PRESS_DY;
    this.pressG.clear();
    // Opaque cover over the baked (unpressed) key AND its down-right shadow, so neither peeks
    // out behind the shifted pressed face. A pressed key has no shadow in the original design,
    // so blanking it here matches that look. White to blend into the near-white panel fill.
    this.pressG.fillStyle(0xffffff, 1);
    this.pressG.fillRoundedRect(rect.cx - rect.w / 2 -4, rect.cy - rect.h / 2 -4, rect.w + 4, rect.h + 5, KEY_RADIUS);
    this.pressG.fillStyle(PALETTE.yellow, 1);
    this.pressG.fillRoundedRect(x, y, rect.w, rect.h, KEY_RADIUS);
    this.pressG.lineStyle(3, PALETTE.ink, 1);
    this.pressG.strokeRoundedRect(x, y, rect.w, rect.h, KEY_RADIUS);
    if (rect.key === 'Backspace') {
      this.strokeBackspace(this.pressG, rect.cx + PRESS_DX, rect.cy + PRESS_DY);
      this.pressLabel.setVisible(false);
    } else {
      this.pressLabel.setText(rect.key).setPosition(rect.cx + PRESS_DX, rect.cy + PRESS_DY).setVisible(true);
    }
    this.pressG.setVisible(true);
  }

  private releaseKeys() {
    if (!this.pressG) return;
    this.pressG.clear().setVisible(false);
    this.pressLabel.setVisible(false);
  }

  // ---------- TEXTURE BAKING ----------

  /** Bake the panel + every key (box, border, letter/glyph) into one canvas texture. */
  private bakePanelTexture() {
    const scene = this.scene;
    const cw = Math.ceil(TEX_PAD + this.panelW + 10);
    const ch = Math.ceil(TEX_PAD + this.panelH + 10);
    if (scene.textures.exists(this.texKey)) scene.textures.remove(this.texKey);
    const tex = scene.textures.createCanvas(this.texKey, cw * TEX_RES, ch * TEX_RES)!;
    const ctx = tex.context;
    ctx.clearRect(0, 0, cw * TEX_RES, ch * TEX_RES);
    ctx.scale(TEX_RES, TEX_RES); // supersample for crisp high-DPI keys
    ctx.translate(TEX_PAD, TEX_PAD); // draw in panel-local space

    // Card-style panel: offset shadow, near-white fill, thick ink border.
    this.roundRect(ctx, 5, 6, this.panelW, this.panelH, PANEL_RADIUS);
    ctx.fillStyle = cssColor(PALETTE.ink, 0.16);
    ctx.fill();
    this.roundRect(ctx, 0, 0, this.panelW, this.panelH, PANEL_RADIUS);
    ctx.fillStyle = cssColor(0xffffff, 0.93);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = cssColor(PALETTE.ink);
    ctx.stroke();

    ctx.font = `900 ${Math.round(this.keyH * 0.42)}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const rect of this.keyRects) {
      const { cx, cy, w, h } = rect;
      // Key shadow (down-right), then white face + ink border.
      this.roundRect(ctx, cx - w / 2 + 3, cy - h / 2 + 4, w, h, KEY_RADIUS);
      ctx.fillStyle = cssColor(PALETTE.ink, 0.18);
      ctx.fill();
      this.roundRect(ctx, cx - w / 2, cy - h / 2, w, h, KEY_RADIUS);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssColor(PALETTE.ink);
      ctx.stroke();
      if (rect.key === 'Backspace') {
        this.ctxBackspace(ctx, cx, cy);
      } else {
        ctx.fillStyle = '#1c1c1c';
        ctx.fillText(rect.key, cx, cy);
      }
    }
    tex.refresh(); // upload to the GPU under WebGL
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  /** Backspace glyph on a 2D context (baked, unpressed). Mirrors strokeBackspace. */
  private ctxBackspace(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.strokeStyle = cssColor(PALETTE.ink);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx - 3, cy - 7);
    ctx.lineTo(cx + 10, cy - 7);
    ctx.lineTo(cx + 10, cy + 7);
    ctx.lineTo(cx - 3, cy + 7);
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 3);
    ctx.lineTo(cx + 6, cy + 3);
    ctx.moveTo(cx + 6, cy - 3);
    ctx.lineTo(cx, cy + 3);
    ctx.stroke();
  }

  /** Backspace glyph on a Phaser Graphics (pressed overlay). Mirrors ctxBackspace. */
  private strokeBackspace(g: Phaser.GameObjects.Graphics, cx: number, cy: number) {
    g.lineStyle(3, PALETTE.ink, 1);
    g.beginPath();
    g.moveTo(cx - 10, cy);
    g.lineTo(cx - 3, cy - 7);
    g.lineTo(cx + 10, cy - 7);
    g.lineTo(cx + 10, cy + 7);
    g.lineTo(cx - 3, cy + 7);
    g.closePath();
    g.strokePath();
    g.lineStyle(2.5, PALETTE.ink, 1);
    g.lineBetween(cx, cy - 3, cx + 6, cy + 3);
    g.lineBetween(cx + 6, cy - 3, cx, cy + 3);
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
