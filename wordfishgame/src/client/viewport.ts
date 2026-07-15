import Phaser from 'phaser';

/**
 * Extra clearance the client must keep clear at the BOTTOM of the canvas for webviews that
 * extend behind browser chrome.
 *
 * Reddit's mobile-web expanded webview is sized with the LARGE viewport (100vh of the host
 * page), so its bottom ~60px sits behind the browser's retractable URL bar — and that clip is
 * invisible from inside the iframe (100dvh here just measures the iframe itself). Anything
 * pinned flush to the canvas bottom (the keyboard, a dragged tile, a popup) ends up under the
 * bar. Heuristic: embedded in an iframe AND a touch device → treat the screen as this much
 * shorter. Desktop reddit (mouse), the native app-style direct webview and the local vite
 * preview all get 0.
 *
 * Shared so the keyboard, the puzzle/tutorial drag clamps, and every popup agree on one
 * number — previously only the keyboard accounted for it, so tiles and the help/win cards
 * could still be dragged or laid out down into the hidden strip.
 */
export function bottomSafeInset(): number {
  let embedded: boolean;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true; // cross-origin parent blocked the check — definitely an iframe
  }
  return embedded && isCoarsePointer() ? 64 : 0;
}

/** True on touch-first devices (phones/tablets), false where a mouse/trackpad drives the
 *  pointer. Used to pick device-appropriate defaults — e.g. the on-screen keyboard starts
 *  open on touch (no physical keys) but minimised on desktop (it would just eat space). */
export function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : 'ontouchstart' in window;
}

/** The usable canvas height once the bottom-unsafe strip (see bottomSafeInset) is removed —
 *  the height layout and centering should treat as the real screen. */
export function safeHeight(scene: Phaser.Scene): number {
  return scene.scale.height - bottomSafeInset();
}
