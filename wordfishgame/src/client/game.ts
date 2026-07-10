import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { BackgroundScene } from './scenes/BackgroundScene';
import { MenuScene } from './scenes/MenuScene';
import { PuzzleScene } from './scenes/PuzzleScene';
import { TutorialScene } from './scenes/TutorialScene';
import { debugEnabled, mountDebugPanel } from './debug';

// The Memphis-styled background scene auto-starts and launches the menu on top of itself;
// the menu then launches the puzzle when a difficulty is chosen. Only the first scene in
// this list auto-starts — the others are launched on demand.
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#f2f0e9',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1024,
    height: 768,
  },
  scene: [BackgroundScene, MenuScene, PuzzleScene, TutorialScene],
};

// Dev-only handle for debugging from the browser console (window.__game).
declare global {
  // Window augmentation requires interface merging — the one place a type alias can't do it.
  interface Window {
    __game?: Game;
  }
}

/**
 * The device pixel ratio to render at, capped at 2. A phone reports up to ~3–4; rendering the
 * buffer at the FULL ratio would cost dpr² the fragment fill and can cost more FPS than the
 * crispness is worth. Capping at 2 removes essentially all of the visible blur (a 1× buffer is
 * the culprit) while keeping the fill bounded. `?hidpi=N` forces a value (including 1, to turn
 * the whole thing off) for testing on any screen.
 */
function effectiveDpr(): number {
  let forced = NaN;
  try {
    const p = new URLSearchParams(window.location.search).get('hidpi');
    if (p) forced = parseFloat(p);
  } catch {
    /* no search params (e.g. inside some webviews) — fall through to the real dpr */
  }
  const dpr = Number.isFinite(forced) && forced > 0 ? forced : window.devicePixelRatio || 1;
  return Math.min(Math.max(dpr, 1), 2);
}

/**
 * Render every Text at the device pixel ratio. A Text renders its own glyphs to an internal
 * canvas at `style.resolution` (default 1); bumping that to the DPR bakes them at full device
 * resolution. Patched once on the prototype so every text (in every file) benefits.
 */
function enableCrispText(dpr: number) {
  if (dpr <= 1) return;
  const proto = Phaser.GameObjects.Text.prototype;
  const original = proto.updateText;
  proto.updateText = function (this: Phaser.GameObjects.Text) {
    if (this.style.resolution !== dpr) this.style.resolution = dpr;
    return original.call(this);
  };
}

/**
 * Render the whole game at the device pixel ratio so it's crisp on a phone.
 *
 * The problem: Phaser's RESIZE scale mode sizes the canvas backing store in CSS pixels, so on
 * a retina/phone screen the browser upscales the entire canvas by the DPR — softening every
 * edge (text, tiles, chain shapes, the lot). Text alone can be fixed with `style.resolution`,
 * but the baked-texture art can't.
 *
 * The fix: enlarge the drawing buffer to `css × dpr` (kept displayed at the CSS size via an
 * explicit style), and tell the renderer + every camera about the bigger buffer. To keep ALL
 * the layout code working in unchanged CSS-pixel coordinates, each camera is zoomed by the DPR
 * (with a top-left origin so the zoom doesn't also shift the view), which maps the CSS-sized
 * world across the device-sized buffer. Pointer input is compensated with a matching
 * displayScale, so world coordinates stay in CSS units end-to-end (see WordTile's use of
 * worldX/worldY). No-op at dpr ≤ 1, so desktop is untouched.
 */
function enableHiDpiRendering(game: Game, dpr: number) {
  if (dpr <= 1) return;
  const scale = game.scale;
  const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  const canvas = game.canvas;
  if (!renderer || typeof renderer.resize !== 'function') return; // headless / canvas fallback

  const applyCamera = (cam: Phaser.Cameras.Scene2D.BaseCamera) => {
    cam.setSize(canvas.width, canvas.height); // cover the full device-pixel buffer (no clip)
    cam.setOrigin(0, 0); // zoom about the top-left so it scales, not recenters, the view
    cam.setZoom(dpr);
  };
  const applySceneCameras = (sceneScale: Phaser.Scene) => {
    sceneScale.cameras?.cameras.forEach(applyCamera);
  };

  const apply = () => {
    const cssW = scale.width;
    const cssH = scale.height;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));

    // Buffer at device pixels; displayed at CSS size.
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      renderer.resize(bw, bh);
    }
    // Map a CSS-space pointer to game space at ×dpr, which the zoomed camera divides back out —
    // so pointer.worldX/Y stay in CSS-logical coordinates, matching where objects are laid out.
    scale.displayScale.set(dpr, dpr);

    for (const s of game.scene.scenes) applySceneCameras(s);
  };

  // Re-apply on every resize (Phaser resets the canvas + cameras to CSS pixels first; our
  // handler runs after and upgrades them). Also catch scenes started/woken later, whose cameras
  // are created fresh at the CSS size.
  scale.on(Phaser.Scale.Events.RESIZE, apply);
  for (const s of game.scene.scenes) {
    s.events.on(Phaser.Scenes.Events.START, () => applySceneCameras(s));
    s.events.on(Phaser.Scenes.Events.WAKE, () => applySceneCameras(s));
  }
  apply();
}

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  const dpr = effectiveDpr();
  enableCrispText(dpr);
  const game = StartGame('game-container');
  window.__game = game;
  // The renderer + scale manager exist once the game has booted; upgrade to hi-DPI then.
  game.events.once(Phaser.Core.Events.READY, () => enableHiDpiRendering(game, dpr));
  if (debugEnabled()) mountDebugPanel(game);
});
