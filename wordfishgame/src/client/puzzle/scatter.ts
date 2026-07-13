/**
 * Scatter tiles to fresh RANDOM positions across the play area — the shuffle button's job.
 *
 * Rather than permuting the existing layout slots (which just swaps who sits where), this
 * throws every tile to a genuinely random spot. To keep it useful and readable — spaced out,
 * not piled up — each tile is placed by best-of-K sampling: it draws several candidate points
 * inside the on-screen band and keeps the one that sits FURTHEST from the tiles already placed,
 * stopping early once a candidate clears everything by `gap`. That reliably spreads them out,
 * and degrades gracefully (still picks the roomiest spot) when the board is too full to fit
 * everyone without touching.
 *
 * Every candidate is drawn from a tile's own valid centre range (half its scaled size in from
 * each edge, plus `margin`), so the returned homes are already fully on-canvas / in-band.
 */
export type ScatterTile = { boxWidth: number; boxHeight: number };

export type ScatterOpts = {
  /** Canvas width. */
  width: number;
  /** Top of the play band — below the corner controls (defaults to 0). */
  top?: number;
  /** Bottom of the play band — usually just above the keyboard. */
  bottom: number;
  /** Shared tile scale for the current canvas. */
  scale: number;
  /** Gap kept between a tile edge and the canvas/band edge. */
  margin: number;
  /** Desired clear space between tiles; a candidate clearing this stops the search early. */
  gap?: number;
  /** Candidate draws per tile. */
  attempts?: number;
  /** Injectable RNG (defaults to Math.random) — [0, 1). */
  rand?: () => number;
};

export function scatterHomes(tiles: ScatterTile[], o: ScatterOpts): { x: number; y: number }[] {
  const rand = o.rand ?? Math.random;
  const gap = o.gap ?? 14;
  const attempts = o.attempts ?? 40;

  const placed: { x: number; y: number; hw: number; hh: number }[] = [];
  const homes: { x: number; y: number }[] = [];

  for (const t of tiles) {
    const top = o.top ?? 0;
    const hw = (t.boxWidth / 2) * o.scale + o.margin;
    const hh = (t.boxHeight / 2) * o.scale + o.margin;
    const minX = hw;
    const maxX = o.width - hw;
    const minY = top + hh;
    const maxY = o.bottom - hh;
    // If a tile is wider/taller than the space, pin it to the centre on that axis.
    const drawX = () => (maxX > minX ? minX + rand() * (maxX - minX) : o.width / 2);
    const drawY = () => (maxY > minY ? minY + rand() * (maxY - minY) : (top + o.bottom) / 2);

    let best = { x: drawX(), y: drawY() };
    let bestClear = -Infinity;
    for (let i = 0; i < attempts; i++) {
      const x = drawX();
      const y = drawY();
      // Clearance to the nearest already-placed tile: on each neighbour, the pair is clear
      // when their bounding boxes miss on either axis, so take the larger of the two axis
      // gaps; the tile's overall clearance is the smallest such value across all neighbours.
      let clear = Infinity;
      for (const p of placed) {
        const gx = Math.abs(x - p.x) - (hw + p.hw);
        const gy = Math.abs(y - p.y) - (hh + p.hh);
        clear = Math.min(clear, Math.max(gx, gy));
      }
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y };
      }
      if (clear >= gap) break; // roomy enough — take it
    }

    placed.push({ x: best.x, y: best.y, hw, hh });
    homes.push(best);
  }

  return homes;
}
