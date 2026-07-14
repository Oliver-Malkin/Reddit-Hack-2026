import * as Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import { bottomSafeInset } from '../viewport';

// Design-size dimensions — the whole card is then uniformly scaled to the viewport (see
// popupScaleFor), so these are what it looks like at scale 1 on a comfortable desktop window,
// not a fixed on-screen size.
const PANEL_W = 320;
// Fits a single-line subtitle ("The word was APPLE"); grows downward when the subtitle
// wraps to more lines (a hard "path5" chain can reveal three hidden words at once, which
// used to spill the subtitle text past the card's edge — see below).
const BASE_PANEL_H = 208;
const RADIUS = 16;
const BORDER = 6;
// The action row is SHARE (primary) beside a HOME button back to the menu; they sit centred
// as a pair within the panel.
const SHARE_W = 176;
const HOME_W = 88;
const BTN_GAP = 10;
const BTN_H = 44;
const SUBTITLE_INSET = 28; // clear margin each side so wrapped text never touches the border

/** Uniform scale for the whole card, based on the current viewport — grows a little on a
 *  roomy desktop window, shrinks on a small phone, same idea as TutorialCoach's bubbleScale. */
function popupScaleFor(W: number, H: number): number {
  const safeH = H - bottomSafeInset();
  return Phaser.Math.Clamp(Math.min(W / 480, safeH / 560), 0.62, 1.15);
}

export type WinPopupOptions = {
  /** The solved hidden word(s), shown in the subtitle. */
  answers: string[];
  /** Called on share click; resolve true if the share text reached the clipboard. */
  onShare: () => Promise<boolean>;
  /** Called on the HOME button — return to the main menu (the × just closes the card). */
  onHome: () => void;
};

/**
 * Memphis-styled "you win" card: white panel, thick ink border, offset shadow,
 * a big title, the revealed word, and a share button with copied-state feedback.
 * Springs in with a Back ease; sits above everything (depth 100).
 */
export class WinPopup extends Phaser.GameObjects.Container {
  // Set once in the constructor from the (possibly wrapped) subtitle height, then read by
  // every other element's layout — see BASE_PANEL_H above.
  private panelH = BASE_PANEL_H;
  private btnLabel: Phaser.GameObjects.Text;
  private btnBg: Phaser.GameObjects.Graphics;
  /** Centre x of the SHARE pill — drawButton redraws it here on copy feedback. */
  private shareCX = 0;
  private shareBusy = false;
  // Once destroyed, the deferred share callbacks (the clipboard promise and the button
  // revert tween) must not touch the now-dead graphics — that used to throw and freeze the
  // whole game if the card was closed before they fired.
  private killed = false;

  constructor(scene: Phaser.Scene, x: number, y: number, options: WinPopupOptions) {
    super(scene, x, y);
    this.once(Phaser.GameObjects.Events.DESTROY, () => (this.killed = true));

    // Built and measured FIRST: a hard puzzle can reveal up to three hidden words at
    // once, and however many lines that wraps to determines how tall the card needs to
    // be. Every other element below is positioned off `this.panelH`, computed here.
    const words = options.answers;
    const subtitleText =
      words.length > 1
        ? `The words were ${words.slice(0, -1).join(', ')} & ${words[words.length - 1]}`
        : `The word was ${words[0] ?? ''}`;
    const subtitle = scene.add.text(0, 0, subtitleText, {
      fontFamily: UI_FONT,
      fontSize: '15px',
      fontStyle: '800',
      color: '#2b2d6e',
      align: 'center',
      wordWrap: { width: PANEL_W - SUBTITLE_INSET * 2, useAdvancedWrap: true },
    });
    subtitle.setOrigin(0.5, 0);
    const lineCount = Math.max(1, subtitle.getWrappedText(subtitleText).length);
    const lineHeight = subtitle.height / lineCount;
    this.panelH = BASE_PANEL_H + lineHeight * (lineCount - 1);
    const panelH = this.panelH;
    subtitle.setY(-panelH / 2 + 78);

    // Offset shadow + panel.
    const panel = scene.add.graphics();
    panel.fillStyle(PALETTE.ink, 0.2);
    panel.fillRoundedRect(-PANEL_W / 2 + 8, -panelH / 2 + 9, PANEL_W, panelH, RADIUS);
    panel.fillStyle(0xffffff, 1);
    panel.fillRoundedRect(-PANEL_W / 2, -panelH / 2, PANEL_W, panelH, RADIUS);
    panel.lineStyle(BORDER, PALETTE.ink, 1);
    panel.strokeRoundedRect(-PANEL_W / 2, -panelH / 2, PANEL_W, panelH, RADIUS);
    // A couple of Memphis accents on the card (top-right corner is reserved for the
    // close button, added below).
    panel.fillStyle(PALETTE.pink, 1);
    panel.fillCircle(-PANEL_W / 2 + 26, -panelH / 2 + 24, 6);
    panel.fillStyle(PALETTE.cyan, 1);
    panel.fillCircle(PANEL_W / 2 - 24, panelH / 2 - 22, 6);
    this.add(panel);

    // The whole card is a drag handle, so the win screen can be nudged aside (matching the
    // draggable tutorial coach + word tiles). Added before the buttons below, which render
    // on top and still take their own taps; only empty card area starts a drag. Dragging is
    // tracked from a captured grab offset so it's immune to the card's spring-in scale.
    const dragHandle = scene.add.container(0, 0);
    dragHandle.setSize(PANEL_W, panelH);
    dragHandle.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(-PANEL_W / 2, -panelH / 2, PANEL_W, panelH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      draggable: true,
      useHandCursor: true,
    });
    let grabX = 0;
    let grabY = 0;
    dragHandle.on('dragstart', (p: Phaser.Input.Pointer) => {
      grabX = this.x - p.worldX;
      grabY = this.y - p.worldY;
    });
    dragHandle.on('drag', (p: Phaser.Input.Pointer) => {
      const { x, y } = this.clampToScreen(p.worldX + grabX, p.worldY + grabY);
      this.setPosition(x, y);
    });
    this.add(dragHandle);

    const title = scene.add.text(0, -panelH / 2 + 48, 'YOU WIN!', {
      fontFamily: UI_FONT,
      fontSize: '34px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    title.setOrigin(0.5);
    this.add(title);

    this.add(subtitle);

    // Action row: SHARE (primary yellow pill) beside a HOME button back to the menu, centred
    // as a pair. Each has its own offset shadow and an invisible top-left-origin hit zone.
    const btnY = panelH / 2 - 50;
    const groupW = SHARE_W + BTN_GAP + HOME_W;
    const shareCX = (this.shareCX = -groupW / 2 + SHARE_W / 2);
    const homeCX = groupW / 2 - HOME_W / 2;

    this.btnBg = scene.add.graphics();
    this.drawButton(PALETTE.yellow);
    this.add(this.btnBg);

    this.btnLabel = scene.add.text(shareCX, btnY, 'SHARE', {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    this.btnLabel.setOrigin(0.5);
    this.add(this.btnLabel);

    const hit = scene.add.container(shareCX, btnY);
    hit.setSize(SHARE_W, BTN_H);
    hit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, SHARE_W, BTN_H),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    hit.on('pointerdown', () => {
      if (this.shareBusy) return;
      this.shareBusy = true;
      void options.onShare().then((ok) => {
        if (this.killed) return; // card was closed before the clipboard write resolved
        this.drawButton(ok ? PALETTE.green : PALETTE.red);
        this.btnLabel.setText(ok ? 'COPIED!' : 'COPY FAILED');
        this.btnLabel.setColor('#ffffff');
        // Revert after a moment so it can be shared again.
        scene.tweens.addCounter({
          from: 0,
          to: 1,
          duration: 1600,
          onComplete: () => {
            if (this.killed) return; // closed mid-wait — don't touch destroyed graphics
            this.drawButton(PALETTE.yellow);
            this.btnLabel.setText('SHARE').setColor('#1c1c1c');
            this.shareBusy = false;
          },
        });
      });
    });
    this.add(hit);

    // HOME — white pill, static; an easy one-tap back to the main menu (rather than hunting
    // for the corner home button behind the celebration).
    const homeBg = scene.add.graphics();
    homeBg.fillStyle(PALETTE.ink, 0.25);
    homeBg.fillRoundedRect(homeCX - HOME_W / 2 + 4, btnY - BTN_H / 2 + 5, HOME_W, BTN_H, BTN_H / 2);
    homeBg.fillStyle(0xffffff, 1);
    homeBg.fillRoundedRect(homeCX - HOME_W / 2, btnY - BTN_H / 2, HOME_W, BTN_H, BTN_H / 2);
    homeBg.lineStyle(4, PALETTE.ink, 1);
    homeBg.strokeRoundedRect(homeCX - HOME_W / 2, btnY - BTN_H / 2, HOME_W, BTN_H, BTN_H / 2);
    this.add(homeBg);

    const homeLabel = scene.add.text(homeCX, btnY, 'HOME', {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    homeLabel.setOrigin(0.5);
    this.add(homeLabel);

    const homeHit = scene.add.container(homeCX, btnY);
    homeHit.setSize(HOME_W, BTN_H);
    homeHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, HOME_W, BTN_H),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    homeHit.on('pointerdown', () => {
      this.disableInteractive();
      options.onHome();
    });
    this.add(homeHit);

    // Close button — white disc with an ink "×" in the top-right corner.
    const cx = PANEL_W / 2 - 22;
    const cy = -panelH / 2 + 22;
    const close = scene.add.graphics();
    close.fillStyle(0xffffff, 1);
    close.fillCircle(cx, cy, 14);
    close.lineStyle(3, PALETTE.ink, 1);
    close.strokeCircle(cx, cy, 14);
    close.lineStyle(3, PALETTE.ink, 1);
    close.lineBetween(cx - 5, cy - 5, cx + 5, cy + 5);
    close.lineBetween(cx + 5, cy - 5, cx - 5, cy + 5);
    this.add(close);

    // Hit area is a top-left-origin rect (Phaser measures a Container's hit-area local
    // point from its top-left, so a centered Circle(0,0,…) would miss — same gotcha as
    // the word tiles).
    const closeHit = scene.add.container(cx, cy);
    closeHit.setSize(36, 36);
    closeHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, 36, 36),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    closeHit.on('pointerdown', () => this.dismiss());
    this.add(closeHit);

    scene.add.existing(this);
    this.setDepth(100);

    // Spring in, settling at the viewport-scaled size (see popupScaleFor) rather than a fixed
    // 1 — so the card is a comfortable size on a roomy desktop window and shrinks to fit a
    // small phone, instead of always rendering at its design size regardless of the screen.
    const cardScale = popupScaleFor(scene.scale.width, scene.scale.height);
    this.setScale(0);
    this.setRotation(-0.04);
    scene.tweens.add({
      targets: this,
      scaleX: cardScale,
      scaleY: cardScale,
      rotation: 0,
      duration: 420,
      ease: 'Back.easeOut',
    });
  }

  /** Spring the card away and destroy it. */
  dismiss() {
    this.disableInteractive();
    this.scene.tweens.add({
      targets: this,
      scaleX: 0,
      scaleY: 0,
      rotation: 0.05,
      duration: 240,
      ease: 'Back.easeIn',
      onComplete: () => this.destroy(),
    });
  }

  /** Keep the card's panel fully on-screen while it's dragged, so it can be nudged aside but
   *  never off the edge (matching the word tiles). If the canvas is narrower/shorter than the
   *  panel, it pins to centre on that axis rather than jamming against one edge. */
  private clampToScreen(x: number, y: number): { x: number; y: number } {
    const W = this.scene.scale.width;
    // Treat the screen as ending above the URL-bar strip so the card can't be nudged under it.
    const H = this.scene.scale.height - bottomSafeInset();
    // Account for the viewport scale so the (possibly grown/shrunk) card is clamped by its
    // real on-screen size, not its unscaled design size.
    const halfW = (PANEL_W * this.scaleX) / 2;
    const halfH = (this.panelH * this.scaleY) / 2;
    return {
      x: halfW > W - halfW ? W / 2 : Phaser.Math.Clamp(x, halfW, W - halfW),
      y: halfH > H - halfH ? H / 2 : Phaser.Math.Clamp(y, halfH, H - halfH),
    };
  }

  private drawButton(fill: number) {
    const btnY = this.panelH / 2 - 50;
    const cx = this.shareCX;
    const g = this.btnBg;
    g.clear();
    g.fillStyle(PALETTE.ink, 0.25);
    g.fillRoundedRect(cx - SHARE_W / 2 + 4, btnY - BTN_H / 2 + 5, SHARE_W, BTN_H, BTN_H / 2);
    g.fillStyle(fill, 1);
    g.fillRoundedRect(cx - SHARE_W / 2, btnY - BTN_H / 2, SHARE_W, BTN_H, BTN_H / 2);
    g.lineStyle(4, PALETTE.ink, 1);
    g.strokeRoundedRect(cx - SHARE_W / 2, btnY - BTN_H / 2, SHARE_W, BTN_H, BTN_H / 2);
  }
}
