/**
 * The device pixel ratio the game renders at, capped at 2. A phone reports up to ~3–4;
 * rendering the buffer at the FULL ratio would cost dpr² the fragment fill and can cost more
 * FPS than the crispness is worth. Capping at 2 removes essentially all of the visible blur
 * (a 1× buffer is the culprit) while keeping the fill bounded. `?hidpi=N` forces a value
 * (including 1, to turn the whole thing off) for testing on any screen.
 *
 * Shared so the renderer setup (game.ts) and the baked-title resolution (titleStyles.ts) agree
 * on exactly one number — the title art has to be baked relative to the same ratio it's shown at.
 */
export function effectiveDpr(): number {
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
