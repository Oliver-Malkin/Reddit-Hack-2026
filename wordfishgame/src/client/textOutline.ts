/**
 * Outlined canvas text WITHOUT strokeText's cross-platform trap.
 *
 * `strokeText` outlines every subpath of every glyph. On desktop that's fine: static fonts
 * like Arial Black ship with de-overlapped outlines. But phones don't have Arial Black —
 * Android falls back to its system Roboto, which is a VARIABLE font, and variable fonts
 * keep overlapping contours (they can't be flattened per-instance). Stroking those glyphs
 * paints the borders of the overlaps as stray dark marks INSIDE the letters — the "parts
 * of borders of parts of letters" artifact on the title and splash. (Reproducible on
 * Windows by stroking with Bahnschrift, its built-in variable font.)
 *
 * The fix: build the outline as a RING instead. Stroke at double width on a scratch canvas,
 * then ERASE the whole glyph interior with fillText — fills use the nonzero winding rule,
 * so overlapping contours fill solid and the erase wipes every interior fragment. What
 * survives is only the outer half of the stroke: a clean ring of `width`, which is then
 * composited with the caller's art. The ring's inner edge and the glyph fill's outer edge
 * carry exactly complementary antialiasing (both come from the same fillText coverage), so
 * they meet in a seamless outline→fill transition.
 */

/** Draws the text run being outlined; called twice with identical geometry. */
export type TextPainter = (ctx: CanvasRenderingContext2D, mode: 'stroke' | 'fill') => void;

/**
 * Composite an outline ring of `width` (extending outward from the glyph edge) onto `ctx`.
 *
 * `compose` picks how the ring meets what's already on the canvas:
 *  - 'behind' (default): slots the ring behind existing art via destination-over — right
 *    when the letters are already painted on a TRANSPARENT canvas (the baked textures).
 *  - 'over': draws the ring on top — for opaque canvases (the splash, painted over its
 *    background); call it BEFORE filling the letters, which then sit on top of the ring.
 *
 * The scratch canvas copies the caller's transform and text settings, so the painter draws
 * identical geometry on both; the result is composited at identity so it lands 1:1.
 */
export function paintOutlineRing(
  ctx: CanvasRenderingContext2D,
  width: number,
  color: string,
  paint: TextPainter,
  compose: 'behind' | 'over' = 'behind'
): void {
  const scratch = document.createElement('canvas');
  scratch.width = ctx.canvas.width;
  scratch.height = ctx.canvas.height;
  const s = scratch.getContext('2d')!;
  s.setTransform(ctx.getTransform());
  s.font = ctx.font;
  s.textAlign = ctx.textAlign;
  s.textBaseline = ctx.textBaseline;
  s.lineJoin = 'round';
  s.lineWidth = width * 2; // half lands outside the glyph — that half is the ring
  s.strokeStyle = color;
  paint(s, 'stroke');
  s.globalCompositeOperation = 'destination-out';
  s.fillStyle = '#000';
  paint(s, 'fill'); // wipe the interior (and with it, every overlap artifact)

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = compose === 'behind' ? 'destination-over' : 'source-over';
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}
