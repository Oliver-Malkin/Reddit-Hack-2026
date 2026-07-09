import * as Phaser from 'phaser';
import type { Game } from 'phaser';

/**
 * Flip this to `true` to force the debug HUD on (handy for phone testing where editing the
 * URL is awkward). It's also enabled automatically whenever the page URL carries `?debug`.
 */
const FORCE_DEBUG = false;

export function debugEnabled(): boolean {
  try {
    return FORCE_DEBUG || new URLSearchParams(window.location.search).has('debug');
  } catch {
    return FORCE_DEBUG;
  }
}

/**
 * Shared per-frame timing sink. The scene writes into it (only bothering to when the HUD
 * is on — see PuzzleScene.update) and the panel reads it. Times are in milliseconds spent
 * this frame; a 60 FPS budget is 16.7 ms total, so anything here in the double digits is a
 * genuine hotspot.
 */
export const perf = { tilesMs: 0, chainsMs: 0, bgMs: 0 };

/**
 * Tiny fixed HUD, built from plain DOM so it stays razor-sharp no matter what the canvas
 * itself is doing. Shows:
 *   - FPS               — Phaser's real update-loop rate (the perf signal).
 *   - renderer          — WebGL vs Canvas fallback.
 *   - dpr               — the device's pixel ratio.
 *   - buffer            — the canvas backing-store size (actual rendered pixels).
 *   - display           — the canvas CSS size on screen.
 *   - renderScale       — buffer ÷ display. If this is below dpr, the canvas is rendering
 *                         at LESS than native resolution — that's the mobile blur. A sharp
 *                         canvas has renderScale == dpr.
 */
export function mountDebugPanel(game: Game) {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'z-index:99999',
    'margin:6px',
    'padding:6px 8px',
    'font:11px/1.4 ui-monospace,Menlo,Consolas,monospace',
    'color:#39ff14',
    'background:rgba(0,0,0,0.72)',
    'border-radius:6px',
    'pointer-events:none',
    'white-space:pre',
    'letter-spacing:0.02em',
  ].join(';');
  document.body.appendChild(el);

  const rendererName =
    game.renderer.type === Phaser.WEBGL
      ? 'WebGL'
      : game.renderer.type === Phaser.CANVAS
        ? 'Canvas'
        : 'headless';

  // Time the render step (the browser-side cost of issuing every draw for the frame) by
  // bracketing Phaser's pre/post-render events. On the Canvas renderer this is where the
  // per-shape rasterisation cost lands; on WebGL it's mostly draw-call submission.
  let renderStart = 0;
  let renderMs = 0;
  game.events.on(Phaser.Core.Events.PRE_RENDER, () => {
    renderStart = performance.now();
  });
  game.events.on(Phaser.Core.Events.POST_RENDER, () => {
    renderMs = performance.now() - renderStart;
  });

  let last = 0;
  const render = (now: number) => {
    // Throttle the DOM writes to ~4 Hz so the text isn't a blur of its own.
    if (now - last >= 250) {
      last = now;
      const c = game.canvas;
      const dpr = window.devicePixelRatio || 1;
      const dispW = c.clientWidth || Math.round(c.width / dpr);
      const dispH = c.clientHeight || Math.round(c.height / dpr);
      const renderScale = dispW ? c.width / dispW : 0;
      const draws = (game.renderer as { drawCount?: number }).drawCount ?? 0;
      // Live display objects across the active scenes, and total loaded textures.
      let objects = 0;
      for (const s of game.scene.getScenes(true)) objects += s.children.list.length;
      const textures = Object.keys(game.textures.list).length;
      el.textContent = [
        `FPS         ${Math.round(game.loop.actualFps)}`,
        `renderer    ${rendererName}`,
        `dpr         ${dpr}`,
        `buffer      ${c.width}x${c.height}`,
        `display     ${dispW}x${dispH}`,
        `renderScale ${renderScale.toFixed(2)}x  (ideal ${dpr})`,
        `draws       ${draws}`,
        `objects     ${objects}`,
        `textures    ${textures}`,
        `bg          ${perf.bgMs.toFixed(1)}ms`,
        `tiles       ${perf.tilesMs.toFixed(1)}ms`,
        `chains      ${perf.chainsMs.toFixed(1)}ms`,
        `render      ${renderMs.toFixed(1)}ms`,
      ].join('\n');
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}
