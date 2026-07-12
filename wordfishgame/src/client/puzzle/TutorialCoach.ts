import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

/** A nav/action button in the coach bubble. */
export type CoachButton = { label: string; onTap: () => void; primary?: boolean };

export type CoachStep = {
  /** The line of guidance. */
  text: string;
  /** Screen-space rect to spotlight, re-evaluated every frame so the highlight tracks a
   *  tile as it is dragged or a chain label as it drifts. Return null (or omit) to dim the
   *  whole canvas with no hole. */
  target?: () => Phaser.Geom.Rectangle | null;
  /** Buttons along the bottom (e.g. Skip / Back / Next). */
  buttons: CoachButton[];
  /** 1-based step position for the progress dots (omit to hide them). */
  progress?: { index: number; total: number };
  /** Set false to drop the dim entirely (still rings the target) so the player can freely
   *  explore the board — used for the "now you try" step. Defaults to true. */
  dim?: boolean;
  /** Where to park the bubble. 'auto' (default) sits it opposite the target; 'top'/'bottom'
   *  pin it to that edge instead — used for the free-play step so the bubble is out of the
   *  middle of the board and the player is nudged to actually poke around. */
  placement?: 'auto' | 'top' | 'bottom';
};

const MARGIN = 16;
const PAD = 18;
const MAX_W = 360;
const BTN_H = 34;
// The dim extends this far past every edge so a small camera move (the wrong-answer shake,
// or a page still settling) can never uncover an un-dimmed strip at the border.
const SCRIM_OVERSCAN = 400;

/**
 * The tutorial's "coach" overlay: a dim wash with a spotlight cut out around the element
 * being explained, plus a Memphis speech-bubble with the text, progress dots and nav
 * buttons. The dim + ring are redrawn every frame from the step's target function, so the
 * highlight follows a tile you drag; the whole overlay fades in the first time it appears
 * (rather than hard-panning in with the page). The dim is non-interactive, so the tiles
 * underneath stay tappable/draggable — needed for the step where you type the answer.
 */
export class TutorialCoach extends Phaser.GameObjects.Container {
  private scrimG: Phaser.GameObjects.Graphics;
  private ringG: Phaser.GameObjects.Graphics;
  private bubble: Phaser.GameObjects.Container | null = null;
  private targetFn: (() => Phaser.Geom.Rectangle | null) | null = null;
  private revealed = false;
  private dimmed = true;
  private placement: 'auto' | 'top' | 'bottom' = 'auto';
  // Lowest y the bubble may reach — kept above the (un-dimmed) keyboard.
  private bottomLimit = Number.POSITIVE_INFINITY;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(120);
    this.setAlpha(0); // fades in on the first show()
    this.scrimG = scene.add.graphics();
    this.ringG = scene.add.graphics();
    this.add([this.scrimG, this.ringG]);
  }

  /** Render a step: (re)build the bubble, draw the spotlight, fade in on first appearance.
   *  `bottomLimit` is the lowest screen y the bubble may occupy (keeps it off the keyboard). */
  show(step: CoachStep, bottomLimit = Number.POSITIVE_INFINITY) {
    const scene = this.scene;
    const W = scene.scale.width;
    const H = scene.scale.height;
    this.bottomLimit = bottomLimit;
    this.targetFn = step.target ?? null;
    this.dimmed = step.dim !== false;
    this.placement = step.placement ?? 'auto';

    this.bubble?.destroy();
    const bubble = this.buildBubble(step);
    this.add(bubble);
    this.bubble = bubble;

    this.refreshSpotlight();
    const targetNow = this.targetFn ? this.targetFn() : null;
    this.positionBubble(bubble, targetNow, W, H);

    bubble.setScale(0.92).setAlpha(0);
    scene.tweens.add({ targets: bubble, scale: 1, alpha: 1, duration: 240, ease: 'Back.easeOut' });

    if (!this.revealed) {
      this.revealed = true;
      scene.tweens.add({ targets: this, alpha: 1, duration: 300 });
    }
  }

  /** Redraw the dim + ring from the current target. Call every frame so the highlight
   *  follows a tile being dragged (or a chain label drifting along its rope). */
  refreshSpotlight() {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const t = this.targetFn ? this.targetFn() : null;
    const M = SCRIM_OVERSCAN;

    const g = this.scrimG;
    g.clear();
    if (this.dimmed) {
      g.fillStyle(PALETTE.ink, 0.5);
      if (!t) {
        g.fillRect(-M, -M, W + M * 2, H + M * 2);
      } else {
        g.fillRect(-M, -M, W + M * 2, t.y + M); // above
        g.fillRect(-M, t.bottom, W + M * 2, H + M - t.bottom); // below
        g.fillRect(-M, t.y, t.x + M, t.height); // left
        g.fillRect(t.right, t.y, W + M - t.right, t.height); // right
      }
    }

    const rg = this.ringG;
    rg.clear();
    if (t) {
      rg.lineStyle(4, 0xffffff, 0.95);
      this.strokeSmoothRoundedRect(rg, t.x, t.y, t.width, t.height, 12);
    }
  }

  /** Stroke a rounded rectangle without the sharp miter spike Phaser's own
   *  strokeRoundedRect leaves where its path closes at a corner: trace the outline as one
   *  continuous path that starts and ends mid-edge, so the only seam sits on a straight run
   *  (a collinear join, i.e. invisible) rather than on a corner. */
  private strokeSmoothRoundedRect(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number
  ) {
    const r = Math.min(radius, w / 2, h / 2);
    const HALF_PI = Math.PI / 2;
    g.beginPath();
    g.moveTo(x + w / 2, y); // mid top edge — the seam lands here, on a straight segment
    g.lineTo(x + w - r, y);
    g.arc(x + w - r, y + r, r, -HALF_PI, 0);
    g.lineTo(x + w, y + h - r);
    g.arc(x + w - r, y + h - r, r, 0, HALF_PI);
    g.lineTo(x + r, y + h);
    g.arc(x + r, y + h - r, r, HALF_PI, Math.PI);
    g.lineTo(x, y + r);
    g.arc(x + r, y + r, r, Math.PI, Math.PI + HALF_PI);
    g.lineTo(x + w / 2, y);
    g.closePath();
    g.strokePath();
  }

  private buildBubble(step: CoachStep): Phaser.GameObjects.Container {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const cardW = Math.min(MAX_W, scene.scale.width - MARGIN * 2);
    const innerW = cardW - PAD * 2;

    const text = scene.add.text(-cardW / 2 + PAD, 0, step.text, {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '700',
      color: '#1c1c1c',
      wordWrap: { width: innerW },
      lineSpacing: 4,
    });
    const textH = text.height;

    const hasProgress = step.progress !== undefined;
    const progressH = hasProgress ? 16 : 0;
    const cardH = PAD + textH + (hasProgress ? 12 + progressH : 0) + 14 + BTN_H + PAD;

    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.2);
    g.fillRoundedRect(-cardW / 2 + 6, -cardH / 2 + 8, cardW, cardH, 18);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
    g.lineStyle(5, PALETTE.ink, 1);
    g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
    c.add(g);

    text.setY(-cardH / 2 + PAD);
    c.add(text);

    if (step.progress) {
      const dotsY = -cardH / 2 + PAD + textH + 12 + progressH / 2;
      c.add(this.buildProgress(step.progress, dotsY));
    }

    // Buttons: primary hugs the right, others pack to its left, and the first "ghost"
    // button (Skip) anchors far left.
    const rowY = cardH / 2 - PAD - BTN_H / 2;
    const chips = step.buttons.map((b) => this.buildChip(b));
    let rightX = cardW / 2 - PAD;
    let skip: { c: Phaser.GameObjects.Container; w: number } | null = null;
    for (let i = chips.length - 1; i >= 0; i--) {
      const chip = chips[i]!;
      if (i === 0 && !step.buttons[0]!.primary && step.buttons.length > 1) {
        skip = chip;
        continue;
      }
      chip.c.setPosition(rightX - chip.w / 2, rowY);
      c.add(chip.c);
      rightX -= chip.w + 8;
    }
    if (skip) {
      skip.c.setPosition(-cardW / 2 + PAD + skip.w / 2, rowY);
      c.add(skip.c);
    }

    // The whole card is a drag handle (so a tile can never get stuck under it), while the
    // buttons — added above it — still take their own taps.
    c.setSize(cardW, cardH);
    c.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, cardW, cardH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      draggable: true,
      useHandCursor: true,
    });
    // Keep the bubble fully on-screen while dragged — it can be nudged aside but never off
    // the edge (matching the word tiles and the win card).
    c.on('drag', (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      const W = scene.scale.width;
      const H = scene.scale.height;
      const halfW = cardW / 2;
      const halfH = cardH / 2;
      const x = halfW > W - halfW ? W / 2 : Phaser.Math.Clamp(dragX, halfW, W - halfW);
      const y = halfH > H - halfH ? H / 2 : Phaser.Math.Clamp(dragY, halfH, H - halfH);
      c.setPosition(x, y);
    });

    return c;
  }

  private buildProgress(p: { index: number; total: number }, y: number): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics();
    const gap = 14;
    const startX = -((p.total - 1) * gap) / 2;
    for (let i = 0; i < p.total; i++) {
      const x = startX + i * gap;
      if (i === p.index - 1) {
        g.fillStyle(PALETTE.pink, 1);
        g.fillCircle(x, y, 4.5);
      } else {
        g.fillStyle(PALETTE.ink, 0.22);
        g.fillCircle(x, y, 3.5);
      }
    }
    return g;
  }

  private buildChip(btn: CoachButton): { c: Phaser.GameObjects.Container; w: number } {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const label = scene.add.text(0, 0, btn.label, {
      fontFamily: UI_FONT,
      fontSize: '14px',
      fontStyle: '900',
      color: btn.primary ? '#ffffff' : '#1c1c1c',
    });
    label.setOrigin(0.5);
    const w = Math.max(64, label.width + 28);
    const h = BTN_H;

    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.2);
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, h / 2);
    g.fillStyle(btn.primary ? PALETTE.green : 0xffffff, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    c.add([g, label]);

    c.setSize(w, h);
    c.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    c.on('pointerdown', () => {
      c.setScale(0.94);
      scene.tweens.add({ targets: c, scale: 1, duration: 120, ease: 'Quad.easeOut' });
      btn.onTap();
    });
    return { c, w };
  }

  /** Place the bubble opposite the spotlight (below a top target, above a bottom one), or
   *  centred when there's no target — always kept inside the canvas margins. */
  private positionBubble(
    bubble: Phaser.GameObjects.Container,
    target: Phaser.Geom.Rectangle | null,
    W: number,
    H: number
  ) {
    const b = bubble.getBounds();
    const halfH = b.height / 2;
    const halfW = b.width / 2;
    // Keep the bubble above the keyboard (which now sits above the dim) as well as the edges.
    const floor = Math.min(H - MARGIN, this.bottomLimit) - halfH;
    const ceil = MARGIN + halfH;
    let cx: number;
    let cy: number;
    if (this.placement !== 'auto') {
      // Pinned toward an edge (free-play step): hug the target horizontally if there is one,
      // else centre. Sit near the top/bottom so the middle of the board stays clear — but
      // with a little breathing room from the edge, so it isn't jammed flush against it.
      cx = target
        ? Phaser.Math.Clamp(target.centerX, MARGIN + halfW, W - MARGIN - halfW)
        : W / 2;
      const inset = Math.min(48, (floor - ceil) * 0.14);
      cy = this.placement === 'top' ? ceil + inset : floor - inset;
    } else if (!target) {
      cx = W / 2;
      cy = H / 2;
    } else {
      // Track the target horizontally (clamped on-screen), so the bubble visibly moves to
      // whatever it is describing — while still fitting a narrow phone.
      cx = Phaser.Math.Clamp(target.centerX, MARGIN + halfW, W - MARGIN - halfW);
      cy = target.centerY < H / 2 ? target.bottom + 20 + halfH : target.y - 20 - halfH;
    }
    cy = Phaser.Math.Clamp(cy, ceil, Math.max(ceil, floor));
    bubble.setPosition(cx, cy);
  }
}
