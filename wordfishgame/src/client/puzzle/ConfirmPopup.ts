import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import { bottomSafeInset } from '../viewport';

export type ConfirmPopupOptions = {
  /** The question/warning shown in the card. */
  message: string;
  /** Label for the destructive/primary action (e.g. "DELETE"). */
  confirmLabel: string;
  onConfirm: () => void;
  /** Called when the popup closes either way (Cancel, dim tap, or after Confirm). */
  onClose: () => void;
};

const MARGIN = 16;
const PAD = 22;
const MAX_W = 360;
const BTN_H = 44;

/**
 * A small modal yes/no card: dims the canvas, floats a message with CANCEL and a destructive
 * confirm button. Used for "are you sure?" moments (e.g. deleting a community puzzle) — mirrors
 * HelpPopup's card styling but much simpler (no scrollable content, fixed two-button layout).
 */
export class ConfirmPopup extends Phaser.GameObjects.Container {
  private opts: ConfirmPopupOptions;
  private overlay: Phaser.GameObjects.Graphics;
  private overlayHit: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Container;
  private resizeHandler: () => void;

  constructor(scene: Phaser.Scene, options: ConfirmPopupOptions) {
    super(scene, 0, 0);
    this.opts = options;
    scene.add.existing(this);
    this.setDepth(160);

    this.overlay = scene.add.graphics();
    this.add(this.overlay);
    this.overlayHit = scene.add.container(0, 0);
    this.overlayHit.on('pointerdown', () => this.dismiss());
    this.add(this.overlayHit);
    this.panel = scene.add.container(0, 0);
    this.add(this.panel);

    this.build(true);

    this.resizeHandler = () => this.build(false);
    scene.scale.on('resize', this.resizeHandler);
    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      scene.scale.off('resize', this.resizeHandler);
    });
  }

  private build(first: boolean) {
    const scene = this.scene;
    const W = scene.scale.width;
    const H = scene.scale.height;
    const safeH = H - bottomSafeInset();

    this.overlay.clear();
    this.overlay.fillStyle(PALETTE.ink, 0.55);
    this.overlay.fillRect(0, 0, W, H);
    this.overlayHit.setSize(W, H);
    this.overlayHit.setPosition(W / 2, H / 2);
    this.overlayHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, W, H),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });

    this.panel.removeAll(true);
    this.panel.setPosition(W / 2, safeH / 2);

    const cardW = Math.min(MAX_W, W - MARGIN * 2);
    const innerW = cardW - PAD * 2;

    const message = scene.add.text(0, 0, this.opts.message, {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '700',
      color: '#1c1c1c',
      align: 'center',
      wordWrap: { width: innerW },
      lineSpacing: 4,
    });
    message.setOrigin(0.5, 0);

    const cardH = PAD + message.height + 20 + BTN_H + PAD;
    message.setPosition(0, -cardH / 2 + PAD);

    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.2);
    g.fillRoundedRect(-cardW / 2 + 6, -cardH / 2 + 8, cardW, cardH, 18);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
    g.lineStyle(5, PALETTE.ink, 1);
    g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 18);
    this.panel.add(g);
    this.panel.add(message);

    const rowY = cardH / 2 - PAD - BTN_H / 2;
    const cancel = this.buildChip('CANCEL', 0xffffff, '#1c1c1c', () => this.dismiss());
    const confirm = this.buildChip(this.opts.confirmLabel, PALETTE.pink, '#ffffff', () => {
      this.opts.onConfirm();
      this.dismiss();
    });
    const gap = 12;
    const totalW = cancel.w + confirm.w + gap;
    cancel.c.setPosition(-totalW / 2 + cancel.w / 2, rowY);
    confirm.c.setPosition(totalW / 2 - confirm.w / 2, rowY);
    this.panel.add([cancel.c, confirm.c]);

    // Swallow taps on the card so only the dim area closes it.
    const cardHit = scene.add.container(0, 0);
    cardHit.setSize(cardW, cardH);
    cardHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(-cardW / 2, -cardH / 2, cardW, cardH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });
    this.panel.addAt(cardHit, 1);

    if (first) {
      this.panel.setScale(0);
      this.panel.setRotation(-0.03);
      scene.tweens.add({
        targets: this.panel,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        duration: 300,
        ease: 'Back.easeOut',
      });
    }
  }

  private buildChip(
    label: string,
    fill: number,
    textColor: string,
    onTap: () => void
  ): { c: Phaser.GameObjects.Container; w: number } {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const text = scene.add.text(0, 0, label, {
      fontFamily: UI_FONT,
      fontSize: '14px',
      fontStyle: '900',
      color: textColor,
    });
    text.setOrigin(0.5);
    const w = Math.max(96, text.width + 28);
    const h = BTN_H;

    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.2);
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, h / 2);
    g.fillStyle(fill, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    c.add([g, text]);

    c.setSize(w, h);
    c.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    c.on('pointerdown', () => {
      c.setScale(0.94);
      scene.tweens.add({ targets: c, scale: 1, duration: 120, ease: 'Quad.easeOut' });
      onTap();
    });
    return { c, w };
  }

  private dismiss() {
    this.overlayHit.disableInteractive();
    this.scene.tweens.add({
      targets: this.panel,
      scaleX: 0,
      scaleY: 0,
      rotation: 0.04,
      duration: 200,
      ease: 'Back.easeIn',
    });
    this.scene.tweens.add({
      targets: this.overlay,
      alpha: 0,
      duration: 200,
      onComplete: () => {
        this.opts.onClose();
        this.destroy();
      },
    });
  }
}
