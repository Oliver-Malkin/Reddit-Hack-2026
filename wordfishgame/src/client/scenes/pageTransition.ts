import Phaser from 'phaser';
import type { BackgroundScene } from './BackgroundScene';

/**
 * Shared page-to-page transition used by the menu, puzzle and tutorial "pages", which all
 * sit on top of the one shared BackgroundScene. A page swaps read as a camera panning
 * sideways: the outgoing page's camera slides its content off one edge while the incoming
 * page's slides in from the other, and the background pans the same way but less (a more
 * distant parallax layer).
 *
 * Pages are kept alive with sleep/wake rather than stop/start, so a page's own state is
 * preserved and re-entering is cheap; `bringToTop` puts the incoming page above the
 * outgoing one so it reads as covering it. Each page slides ITSELF in via slideCameraIn on
 * create/wake (it knows which edge from the `enterFrom` it's handed); this module drives
 * the outgoing slide and the wake/sleep/parallax sequencing.
 */

export type SlideDir = 'left' | 'right';

/** Data every page receives on launch/wake so it knows which edge to slide in from. */
export type PageEnterData = { enterFrom: SlideDir; [k: string]: unknown };

// Both halves of a page swap share ONE easing + duration so they travel in perfect
// lockstep — the incoming page's leading edge stays pinned to the outgoing page's trailing
// edge, so the two never overlap (which used to smear the new board over the menu text) and
// never leave a gap. A symmetric ease reads as a single unhurried camera pan.
const SLIDE_MS = 760;
const SLIDE_EASE = 'Cubic.easeInOut';

/** Place a scene's camera so its content sits off-screen on `dir`, then glide it to rest.
 *  'right' → the content flies in from the right edge; 'left' → from the left. */
export function slideCameraIn(scene: Phaser.Scene, dir: SlideDir) {
  const cam = scene.cameras.main;
  const W = scene.scale.width;
  cam.setScroll(dir === 'right' ? -W : W, 0);
  scene.tweens.killTweensOf(cam);
  scene.tweens.add({ targets: cam, scrollX: 0, duration: SLIDE_MS, ease: SLIDE_EASE });
}

/** Glide a scene's content off-screen toward `dir`, then run `onDone`. */
export function slideCameraOut(scene: Phaser.Scene, dir: SlideDir, onDone: () => void) {
  const cam = scene.cameras.main;
  const W = scene.scale.width;
  scene.tweens.killTweensOf(cam);
  scene.tweens.add({
    targets: cam,
    scrollX: dir === 'right' ? -W : W,
    duration: SLIDE_MS,
    ease: SLIDE_EASE,
    onComplete: onDone,
  });
}

/** The slide duration (ms), so callers can time follow-on effects (e.g. the tutorial coach
 *  fading in only once the page has arrived). */
export const SLIDE_DURATION = SLIDE_MS;

/** The opposite edge — an exit to the left means the incoming page enters from the right. */
function opposite(dir: SlideDir): SlideDir {
  return dir === 'left' ? 'right' : 'left';
}

// One page swap at a time. Both pages are awake mid-slide and the incoming one is already
// interactive, so without this a click during a transition could kick off a second one and
// leave a scene stuck awake-but-disabled. Callers check isTransitioning() before starting.
let busy = false;

/** True while a page swap is mid-flight — scenes gate their nav buttons on this. */
export function isTransitioning(): boolean {
  return busy;
}

/**
 * Swap pages instantly — no slide. Used when a full-screen DOM overlay (the puzzle editor)
 * covers the canvas: the destination must simply BE there when the overlay lifts, because
 * any sliding menu glimpsed beneath a fading overlay reads as a glitch. The incoming page
 * gets no `enterFrom`, which every page treats as "snap into place".
 */
export function jumpToPage(
  from: Phaser.Scene,
  toKey: string,
  data: Record<string, unknown>,
  parallax: number
) {
  if (busy) return;
  const mgr = from.scene;
  mgr.bringToTop(toKey);
  if (mgr.isSleeping(toKey)) mgr.wake(toKey, data);
  else mgr.launch(toKey, data);

  const bg = mgr.get('BackgroundScene') as BackgroundScene;
  bg.panParallaxTo(parallax, 0); // snap — nothing should visibly move during a jump

  mgr.sleep();
}

/**
 * Transition from `from` to the page `toKey`. `from` slides out toward `exitDir` and is
 * put to sleep; `toKey` is woken (or launched the first time) on top, sliding in from the
 * opposite edge, and the background pans to `parallax`.
 */
export function transitionToPage(
  from: Phaser.Scene,
  toKey: string,
  data: Record<string, unknown>,
  exitDir: SlideDir,
  parallax: number
) {
  if (busy) return;
  busy = true;
  const mgr = from.scene;
  const enterData: PageEnterData = { ...data, enterFrom: opposite(exitDir) };

  mgr.bringToTop(toKey);
  // A page is either dormant (asleep) or not yet launched when we move to it — the active
  // page is always `from`, which we're leaving.
  if (mgr.isSleeping(toKey)) mgr.wake(toKey, enterData);
  else mgr.launch(toKey, enterData);

  const bg = mgr.get('BackgroundScene') as BackgroundScene;
  bg.panParallaxTo(parallax);

  slideCameraOut(from, exitDir, () => {
    mgr.sleep();
    busy = false;
  });
}
