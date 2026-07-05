import * as Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

const PANEL_W = 340;
const PANEL_H = 220;
const RADIUS = 16;
const BORDER = 6;
const BTN_W = 190;
const BTN_H = 46;

export type WinPopupOptions = {
  /** The solved word, shown in the subtitle. */
  answer: string;
  /** Called on share click; resolve true if the share text reached the clipboard. */
  onShare: () => Promise<boolean>;
};

/**
 * Memphis-styled "you win" card: white panel, thick ink border, offset shadow,
 * a big title, the revealed word, and a share button with copied-state feedback.
 * Springs in with a Back ease; sits above everything (depth 100).
 */
export class WinPopup extends Phaser.GameObjects.Container {
  private btnLabel: Phaser.GameObjects.Text;
  private btnBg: Phaser.GameObjects.Graphics;
  private shareBusy = false;

  constructor(scene: Phaser.Scene, x: number, y: number, options: WinPopupOptions) {
    super(scene, x, y);

    // Offset shadow + panel.
    const panel = scene.add.graphics();
    panel.fillStyle(PALETTE.ink, 0.2);
    panel.fillRoundedRect(-PANEL_W / 2 + 8, -PANEL_H / 2 + 9, PANEL_W, PANEL_H, RADIUS);
    panel.fillStyle(0xffffff, 1);
    panel.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, RADIUS);
    panel.lineStyle(BORDER, PALETTE.ink, 1);
    panel.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, RADIUS);
    // A couple of Memphis accents on the card (top-right corner is reserved for the
    // close button, added below).
    panel.fillStyle(PALETTE.pink, 1);
    panel.fillCircle(-PANEL_W / 2 + 26, -PANEL_H / 2 + 24, 6);
    panel.fillStyle(PALETTE.cyan, 1);
    panel.fillCircle(PANEL_W / 2 - 24, PANEL_H / 2 - 22, 6);
    this.add(panel);

    const title = scene.add.text(0, -PANEL_H / 2 + 52, 'YOU WIN!', {
      fontFamily: UI_FONT,
      fontSize: '36px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    title.setOrigin(0.5);
    this.add(title);

    const subtitle = scene.add.text(0, -PANEL_H / 2 + 96, `The word was ${options.answer}`, {
      fontFamily: UI_FONT,
      fontSize: '15px',
      fontStyle: '800',
      color: '#2b2d6e',
    });
    subtitle.setOrigin(0.5);
    this.add(subtitle);

    // Share button — yellow pill, ink border, its own offset shadow.
    const btnY = PANEL_H / 2 - 50;
    this.btnBg = scene.add.graphics();
    this.drawButton(PALETTE.yellow);
    this.add(this.btnBg);

    this.btnLabel = scene.add.text(0, btnY, 'SHARE RESULT', {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    this.btnLabel.setOrigin(0.5);
    this.add(this.btnLabel);

    // Invisible hit zone over the button (containers hit-test from their top-left).
    const hit = scene.add.container(0, btnY);
    hit.setSize(BTN_W, BTN_H);
    hit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, BTN_W, BTN_H),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    hit.on('pointerdown', () => {
      if (this.shareBusy) return;
      this.shareBusy = true;
      void options.onShare().then((ok) => {
        this.drawButton(ok ? PALETTE.green : PALETTE.red);
        this.btnLabel.setText(ok ? 'COPIED!' : 'COPY FAILED');
        this.btnLabel.setColor(ok ? '#ffffff' : '#ffffff');
        // Revert after a moment so it can be shared again.
        scene.tweens.addCounter({
          from: 0,
          to: 1,
          duration: 1600,
          onComplete: () => {
            this.drawButton(PALETTE.yellow);
            this.btnLabel.setText('SHARE RESULT').setColor('#1c1c1c');
            this.shareBusy = false;
          },
        });
      });
    });
    this.add(hit);

    // Close button — white disc with an ink "×" in the top-right corner.
    const cx = PANEL_W / 2 - 22;
    const cy = -PANEL_H / 2 + 22;
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

    // Spring in.
    this.setScale(0);
    this.setRotation(-0.04);
    scene.tweens.add({
      targets: this,
      scaleX: 1,
      scaleY: 1,
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

  private drawButton(fill: number) {
    const btnY = PANEL_H / 2 - 50;
    const g = this.btnBg;
    g.clear();
    g.fillStyle(PALETTE.ink, 0.25);
    g.fillRoundedRect(-BTN_W / 2 + 4, btnY - BTN_H / 2 + 5, BTN_W, BTN_H, BTN_H / 2);
    g.fillStyle(fill, 1);
    g.fillRoundedRect(-BTN_W / 2, btnY - BTN_H / 2, BTN_W, BTN_H, BTN_H / 2);
    g.lineStyle(4, PALETTE.ink, 1);
    g.strokeRoundedRect(-BTN_W / 2, btnY - BTN_H / 2, BTN_W, BTN_H, BTN_H / 2);
  }
}
