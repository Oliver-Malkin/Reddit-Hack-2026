import Phaser from 'phaser';
import { IconButton } from './IconButton';
import { PALETTE, UI_FONT } from '../theme';
import type { BackgroundScene } from '../scenes/BackgroundScene';

/** The decor toggle's face: a bold "BG" monogram (for the drifting background decorations),
 *  struck through in red when those decorations are hidden. */
export function drawDecorGlyph(face: Phaser.GameObjects.Container, hidden: boolean) {
  const scene = face.scene;
  const label = scene.add
    .text(0, 0, 'BG', {
      fontFamily: UI_FONT,
      fontSize: '16px',
      fontStyle: '900',
      color: hidden ? '#9a968c' : '#1c1c1c',
    })
    .setOrigin(0.5);
  face.add(label);
  if (hidden) {
    const g = scene.add.graphics();
    g.lineStyle(3, PALETTE.red, 1);
    g.lineBetween(-13, 8, 13, -8);
    face.add(g);
  }
}

/**
 * A round icon button that toggles the shared BackgroundScene "clean mode" (hide the
 * drifting shapes + squiggles). The on/off state lives on the BackgroundScene, so the menu
 * and the puzzle share one setting; each button just re-reads it. `onToggle` fires after a
 * flip (e.g. for a sound).
 */
export function createDecorToggle(scene: Phaser.Scene, onToggle?: () => void): IconButton {
  const bg = scene.scene.get('BackgroundScene') as BackgroundScene;
  const btn = new IconButton(scene, 0, 0, {
    onTap: () => {
      const hidden = !bg.isDecorHidden();
      bg.setDecorHidden(hidden);
      btn.setFace((f) => drawDecorGlyph(f, hidden));
      onToggle?.();
    },
  });
  btn.setFace((f) => drawDecorGlyph(f, bg.isDecorHidden()));
  return btn;
}
