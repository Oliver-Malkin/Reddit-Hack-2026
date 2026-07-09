import * as Phaser from 'phaser';
import type { Game } from 'phaser';
import { copyText } from './clipboard';

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
 * Debug-only layer switches read from the URL (e.g. `?debug&noshapes`). Used to attribute the
 * per-frame draw-call count to individual layers: disable one, tap-copy `draws/frame`, compare.
 * Known flags: nosquiggles, noshapes, nokeyboard, nochains. No-ops unless the flag is present.
 */
export function debugFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).has(name);
  } catch {
    return false;
  }
}

/**
 * A rolling accumulator for per-frame samples. The whole point: on a phone webview
 * `performance.now()` is coarsened to ~1ms (no cross-origin isolation), so a single-frame
 * duration reads as 0, 1 or 2 ms and never anything in between. Averaging many frames'
 * worth of those coarse readings recovers the true sub-millisecond mean — which is why every
 * timing in the HUD is an average over the ~250ms refresh window rather than an instant value.
 */
class Rolling {
  private sum = 0;
  private n = 0;
  private max = 0;

  add(v: number) {
    this.sum += v;
    this.n += 1;
    if (v > this.max) this.max = v;
  }

  /** Average + worst since the last drain, then reset. `n` is samples seen this window. */
  drain(): { avg: number; max: number; n: number } {
    const out = { avg: this.n ? this.sum / this.n : 0, max: this.max, n: this.n };
    this.sum = 0;
    this.n = 0;
    this.max = 0;
    return out;
  }
}

/**
 * Shared per-frame timing sink. The scenes feed samples in (only bothering to when the HUD
 * is on — see each scene's update) and the panel drains them once per window. Times are in
 * milliseconds spent that frame; a 60 FPS budget is 16.7 ms total, 120 FPS is 8.3 ms.
 */
export const perf = {
  tiles: new Rolling(),
  chains: new Rolling(),
  bg: new Rolling(),
};

/** Loose view of the bits of Phaser's WebGL renderer we reach past the public types for. */
type GlRenderer = { gl?: WebGL2RenderingContext | WebGLRenderingContext };

/**
 * Wrap the GL context's draw entry points so we can count real draw calls per frame — Phaser
 * exposes no reliable public counter. Returns a getter/reset pair; null on the Canvas renderer.
 */
function installDrawCounter(gl: WebGL2RenderingContext | WebGLRenderingContext) {
  let count = 0;
  const names = [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
  ] as const;
  for (const name of names) {
    const ctx = gl as unknown as Record<string, unknown>;
    const orig = ctx[name];
    if (typeof orig !== 'function') continue;
    const bound = (orig as (...a: unknown[]) => unknown).bind(gl);
    ctx[name] = (...args: unknown[]) => {
      count += 1;
      return bound(...args);
    };
  }
  return {
    read: () => count,
    reset: () => {
      count = 0;
    },
  };
}

/**
 * A GPU query handle is opaque — WebGL2 hands back a WebGLQuery, the WebGL1 extension a
 * WebGLTimerQueryEXT (not in lib.dom). We only ever pass them back to the API that made them.
 */
type Query = object;

/** Normalised timer-query surface so the queue logic below is written once for both GL versions. */
type QueryApi = {
  create(): Query | null;
  begin(q: Query): void;
  end(): void;
  available(q: Query): boolean;
  resultNs(q: Query): number;
  destroy(q: Query): void;
  disjoint(): boolean;
};

/** WebGL1 EXT_disjoint_timer_query — separate object-based API from the WebGL2 version. */
type TimerExt1 = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
  QUERY_RESULT_EXT: number;
  QUERY_RESULT_AVAILABLE_EXT: number;
  createQueryEXT(): Query;
  deleteQueryEXT(q: Query): void;
  beginQueryEXT(target: number, q: Query): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(q: Query, pname: number): number | boolean;
};

type TimerExt2 = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/** Build a QueryApi from whichever timer extension the context supports, or null. */
function resolveQueryApi(gl: WebGL2RenderingContext | WebGLRenderingContext): QueryApi | null {
  const gl2 = gl as WebGL2RenderingContext;
  if (typeof gl2.createQuery === 'function') {
    const ext = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt2 | null;
    if (ext) {
      return {
        create: () => gl2.createQuery(),
        begin: (q) => gl2.beginQuery(ext.TIME_ELAPSED_EXT, q as WebGLQuery),
        end: () => gl2.endQuery(ext.TIME_ELAPSED_EXT),
        available: (q) => !!gl2.getQueryParameter(q as WebGLQuery, gl2.QUERY_RESULT_AVAILABLE),
        resultNs: (q) => gl2.getQueryParameter(q as WebGLQuery, gl2.QUERY_RESULT) as number,
        destroy: (q) => gl2.deleteQuery(q as WebGLQuery),
        disjoint: () => !!gl2.getParameter(ext.GPU_DISJOINT_EXT),
      };
    }
  }
  const ext1 = gl.getExtension('EXT_disjoint_timer_query') as TimerExt1 | null;
  if (ext1 && typeof ext1.createQueryEXT === 'function') {
    return {
      create: () => ext1.createQueryEXT(),
      begin: (q) => ext1.beginQueryEXT(ext1.TIME_ELAPSED_EXT, q),
      end: () => ext1.endQueryEXT(ext1.TIME_ELAPSED_EXT),
      available: (q) => !!ext1.getQueryObjectEXT(q, ext1.QUERY_RESULT_AVAILABLE_EXT),
      resultNs: (q) => ext1.getQueryObjectEXT(q, ext1.QUERY_RESULT_EXT) as number,
      destroy: (q) => ext1.deleteQueryEXT(q),
      disjoint: () => !!gl.getParameter(ext1.GPU_DISJOINT_EXT),
    };
  }
  return null;
}

/**
 * GPU frame time via the disjoint-timer-query extension (WebGL2 or WebGL1). This is the
 * measurement that separates "the CPU is slow issuing draws" from "the GPU is slow drawing
 * them" — the PRE/POST_RENDER bracket only sees CPU submission, which returns long before the
 * GPU finishes. Queries are fired per frame and their results collected a few frames later
 * when ready. Returns null when no timer extension is exposed.
 */
function installGpuTimer(gl: WebGL2RenderingContext | WebGLRenderingContext) {
  const api = resolveQueryApi(gl);
  if (!api) return null;

  const result = new Rolling();
  const pending: Query[] = [];
  let active: Query | null = null;

  return {
    result,
    begin() {
      if (active) return; // never nest TIME_ELAPSED queries
      const q = api.create();
      if (!q) return;
      active = q;
      api.begin(q);
    },
    end() {
      if (active) {
        api.end();
        pending.push(active);
        active = null;
      }
      // If the timer disjointed (GPU context switch / throttle) the in-flight results are
      // garbage — drop them rather than report a wild spike.
      const disjoint = api.disjoint();
      while (pending.length) {
        const q = pending[0]!;
        if (!api.available(q)) break;
        if (!disjoint) result.add(api.resultNs(q) / 1e6);
        api.destroy(q);
        pending.shift();
      }
    },
  };
}

/**
 * Probe the actual resolution of `performance.now()` by spinning until it ticks. On a
 * cross-origin-isolated page this is ~5µs; in a plain webview it's clamped to ~1ms, which is
 * why raw per-frame timings look quantised. Capped so it can't hang if the clock is stuck.
 */
function probeTimerResolution(): number {
  const start = performance.now();
  let now = start;
  let guard = 0;
  while (now === start && guard < 1e6) {
    now = performance.now();
    guard += 1;
  }
  return now - start;
}

/**
 * Tiny fixed HUD, built from plain DOM so it stays razor-sharp no matter what the canvas
 * itself is doing. Every ms figure is `avg·worst` over the refresh window (see Rolling).
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
    'pointer-events:auto', // tap-to-copy — see below
    'cursor:pointer',
    'white-space:pre',
    'letter-spacing:0.02em',
  ].join(';');
  document.body.appendChild(el);

  // Tap-to-copy: on a phone, typing the readout back by hand (or shipping screenshots) is
  // painful, so a tap drops the current panel text on the clipboard. `copiedUntil` keeps the
  // "copied" banner up across the 4Hz redraws below rather than being overwritten instantly.
  let latestText = '';
  let copiedUntil = 0;
  el.addEventListener('click', () => {
    void copyText(latestText).then((ok) => {
      if (ok) copiedUntil = performance.now() + 1200;
    });
  });

  const gl = (game.renderer as unknown as GlRenderer).gl;
  const isWebgl = game.renderer.type === Phaser.WEBGL;
  const rendererName = isWebgl
    ? gl instanceof WebGL2RenderingContext
      ? 'WebGL2'
      : 'WebGL1'
    : game.renderer.type === Phaser.CANVAS
      ? 'Canvas'
      : 'headless';

  const drawCounter = gl ? installDrawCounter(gl) : null;
  const gpuTimer = gl ? installGpuTimer(gl) : null;
  const timerRes = probeTimerResolution();
  const isolated = (window as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false;

  // CPU-side render submission time, bracketed around Phaser's render step. On WebGL this is
  // draw-call submission (the GPU keeps working after POST_RENDER fires — see gpuTimer).
  const renderMs = new Rolling();
  const drawsPerFrame = new Rolling();
  let renderStart = 0;
  game.events.on(Phaser.Core.Events.PRE_RENDER, () => {
    renderStart = performance.now();
    drawCounter?.reset();
    gpuTimer?.begin();
  });
  game.events.on(Phaser.Core.Events.POST_RENDER, () => {
    renderMs.add(performance.now() - renderStart);
    if (drawCounter) drawsPerFrame.add(drawCounter.read());
    gpuTimer?.end();
  });

  // Frame-time stats measured off rAF: avg tells you the sustained rate, worst exposes the
  // jank a smoothed FPS hides. minDelta estimates the display's true refresh rate.
  const frameMs = new Rolling();
  let lastFrameTs = 0;
  let minDelta = Infinity;

  const fmt = (r: { avg: number; max: number }) =>
    `${r.avg.toFixed(1)}·${r.max.toFixed(0)}`;

  let last = 0;
  const render = (now: number) => {
    if (lastFrameTs) {
      const d = now - lastFrameTs;
      frameMs.add(d);
      if (d > 2 && d < minDelta) minDelta = d; // guard against sub-frame duplicate callbacks
    }
    lastFrameTs = now;

    // Throttle the DOM writes to ~4 Hz so the text isn't a blur of its own.
    if (now - last >= 250) {
      last = now;
      const c = game.canvas;
      const dpr = window.devicePixelRatio || 1;
      const dispW = c.clientWidth || Math.round(c.width / dpr);
      const dispH = c.clientHeight || Math.round(c.height / dpr);
      const renderScale = dispW ? c.width / dispW : 0;
      let objects = 0;
      for (const s of game.scene.getScenes(true)) objects += s.children.list.length;
      const textures = Object.keys(game.textures.list).length;

      const frame = frameMs.drain();
      const refresh = minDelta < Infinity ? Math.round(1000 / minDelta) : 0;
      const draws = drawsPerFrame.drain();
      const gpu = gpuTimer?.result.drain();

      const lines = [
        `FPS          ${Math.round(game.loop.actualFps)}  (frame ${fmt(frame)}ms)`,
        `refresh      ~${refresh || '?'}Hz`,
        `renderer     ${rendererName}`,
        `crossOrigin  ${isolated ? 'isolated' : 'NO (timers coarse)'}`,
        `timer res    ${timerRes.toFixed(3)}ms`,
        `dpr          ${dpr.toFixed(2)}`,
        `buffer       ${c.width}x${c.height}`,
        `display      ${dispW}x${dispH}`,
        `renderScale  ${renderScale.toFixed(2)}x  (native ${dpr.toFixed(2)}x)`,
        `draws/frame  ${draws.avg.toFixed(0)}`,
        `objects      ${objects}`,
        `textures     ${textures}`,
        `── ms/frame (avg·worst) ──`,
        `bg           ${fmt(perf.bg.drain())}`,
        `tiles        ${fmt(perf.tiles.drain())}`,
        `chains       ${fmt(perf.chains.drain())}`,
        `render(cpu)  ${fmt(renderMs.drain())}`,
        `gpu          ${gpu ? fmt(gpu) : 'n/a'}`,
      ];
      latestText = lines.join('\n');
      const banner = now < copiedUntil ? '✓ copied\n' : 'tap to copy\n';
      el.textContent = banner + latestText;
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}
