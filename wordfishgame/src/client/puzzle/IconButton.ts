import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

export type IconButtonOptions = {
  radius?: number;
  /** A bold text glyph (e.g. '?'), OR provide `draw` for a vector glyph. */
  label?: string;
  /** Draw a glyph centred on (0,0); called once, parented into the button. */
  draw?: (g: Phaser.GameObjects.Graphics) => void;
  onTap: () => void;
};

/**
 * A round Memphis control button: white disc, thick ink border, offset shadow, with
 * either a text glyph or a drawn vector glyph. Presses in (shadow collapses, face
 * shifts down-right, disc flashes yellow) like the on-screen keys, for a consistent
 * tactile feel across the UI. Used for the shuffle and help controls.
 */
export class IconButton extends Phaser.GameObjects.Container {
  readonly radius: number;
  private bg: Phaser.GameObjects.Graphics;
  private face: Phaser.GameObjects.Container;
  private onTap: () => void;
  private pressed = false;
  private enabled = true;

  constructor(scene: Phaser.Scene, x: number, y: number, opts: IconButtonOptions) {
    super(scene, x, y);
    this.radius = opts.radius ?? 20;
    this.onTap = opts.onTap;

    this.bg = scene.add.graphics();
    this.add(this.bg);

    this.face = scene.add.container(0, 0);
    if (opts.draw) {
      const g = scene.add.graphics();
      opts.draw(g);
      this.face.add(g);
    } else if (opts.label !== undefined) {
      const t = scene.add.text(0, 0, opts.label, {
        fontFamily: UI_FONT,
        fontSize: `${Math.round(this.radius * 1.25)}px`,
        fontStyle: '900',
        color: '#1c1c1c',
      });
      t.setOrigin(0.5);
      this.face.add(t);
    }
    this.add(this.face);
    this.redraw();

    const r = this.radius;
    this.setSize(r * 2, r * 2);
    this.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, r * 2, r * 2),
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

  /** Grey out and stop responding (e.g. while a modal is open). */
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
    this.face.setPosition(pressed ? 2 : 0, pressed ? 3 : 0);
  }

  private redraw() {
    const r = this.radius;
    const g = this.bg;
    g.clear();
    if (!this.pressed) {
      g.fillStyle(PALETTE.ink, 0.2);
      g.fillCircle(3, 4, r);
    }
    const dx = this.pressed ? 2 : 0;
    const dy = this.pressed ? 3 : 0;
    g.fillStyle(this.pressed ? PALETTE.yellow : 0xffffff, 1);
    g.fillCircle(dx, dy, r);
    g.lineStyle(3.5, PALETTE.ink, 1);
    g.strokeCircle(dx, dy, r);
  }
}
