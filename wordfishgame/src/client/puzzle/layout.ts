/**
 * Shared tile sizing + default board layout.
 *
 * Two jobs, both used by PuzzleScene (and the scale part by TutorialScene):
 *
 *  - `tileScaleFor` picks ONE scale for every tile on the current canvas. Several caps stack:
 *    the widest word fits across the canvas, at least a (count-growing) number of letter-cells
 *    span the width, no tile is wider than HALF the viewport (the hard width rule), no tile is
 *    taller than a couple-rows'-worth of the play band's HEIGHT, and the tiles' total area
 *    leaves the band comfortably fillable. That last pair matters on a short-and-wide canvas
 *    (e.g. landscape with the keyboard open): width alone would happily pick a large scale, but
 *    there's nowhere near enough vertical room to lay several tiles that size out without
 *    overlapping — see graphLayout, which can only rearrange the space it's given, not conjure
 *    more of it.
 *
 *  - `graphLayout` places the tiles. Rather than a rigid index stack it relaxes the tiles under
 *    three forces — box separation (never overlap, keep a little air), link springs (chained
 *    words sit a comfortable rope-length apart, neither kissing nor a screen apart), and a soft
 *    pull to centre (so the cluster floats in the middle, off the edges) — then clamps everyone
 *    inside the play band. The seed and the forces are deterministic, so the same puzzle lays
 *    out the same way every load and glides (not jumps) on resize.
 */
import Phaser from 'phaser';
import { CELL_W, CELL_H } from './WordTile';

/** Minimum gap between a tile's edge and the canvas edge (shared with the scenes). */
export const LAYOUT_MARGIN = 12;

/**
 * Tiles are scaled so at least this many letter-cells span the canvas edge-to-edge, even when
 * the widest word is short — otherwise a short widest word sits big and the chains between
 * tiles are cramped. The minimum GROWS with the tile count so a busy board packs smaller.
 */
const MIN_VISIBLE_CELLS = 15;
/** A tile's (unscaled) height is constant — every WordTile is CELL_H tall regardless of word
 *  length — so the height/area caps below can use it directly. */
const TILE_H = CELL_H;
/** A single tile should never claim more than this fraction of the play band's HEIGHT, so at
 *  least a couple of rows always fit — otherwise a short-but-wide canvas (landscape, keyboard
 *  open) could pick a scale that fits the widest WORD fine but leaves no vertical room to stack
 *  tiles without overlapping. */
const MAX_HEIGHT_FRACTION = 0.36;
/** The tiles' total (unscaled) footprint area, scaled down, should fill at most this fraction of
 *  the play band's area — leaving room for the gaps and margins graphLayout needs to actually
 *  separate them. Tuned so a roomy board still reaches scale 1 while a cramped one (many/wide
 *  words, or a short band) backs off before the layout runs out of space. */
const MAX_AREA_FILL = 0.24;

/** One shared scale for every tile on a `W`×`bandH` canvas (bandH = play band height) holding
 *  tiles whose (unscaled) box widths are `boxWidths`. Several caps stack — see the module doc —
 *  the two hard rules being: no tile wider than half the viewport, and no tile taller than
 *  ~40% of the play band's height. */
export function tileScaleFor(W: number, bandH: number, boxWidths: number[]): number {
  const widest = Math.max(...boxWidths);
  const count = boxWidths.length;
  const minCells = MIN_VISIBLE_CELLS + Math.max(0, count - 3) * 3;
  const cellCap = W / (minCells * CELL_W);
  const halfCap = W / 2 / widest; // widest tile ≤ half the viewport width
  const heightCap = (bandH * MAX_HEIGHT_FRACTION) / TILE_H; // any tile ≤ ~40% of the band height
  const sumArea = boxWidths.reduce((a, w) => a + w, 0) * TILE_H;
  const areaCap = sumArea > 0 ? Math.sqrt((W * bandH * MAX_AREA_FILL) / sumArea) : 1;
  const maxScale = Math.min(1, cellCap, halfCap, heightCap, areaCap);
  // A mild power curve on the sub-1 side shrinks tiles a bit more aggressively as the window
  // gets smaller (a full-size board, maxScale===1, is untouched) — otherwise tiles stayed
  // close to full size until a window shrank quite a lot, then dropped off suddenly.
  const shaped = maxScale < 1 ? Math.pow(maxScale, 1.15) : maxScale;
  // Floor keeps a very long word on a tiny screen readable; in that rare case the other caps may
  // be missed, but everywhere realistic they win.
  return Phaser.Math.Clamp((W - LAYOUT_MARGIN * 2) / widest, 0.3, shaped);
}

/** Tiny deterministic PRNG (mulberry32) — a seeded stand-in for Math.random so a given seed
 *  always yields the same sequence, keeping the layout stable across re-runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of the tile ids — the layout seed, so each distinct puzzle gets its own
 *  (repeatable) tie-break sequence. */
export function hashIds(ids: string[]): number {
  let h = 2166136261;
  for (const s of ids.join('|')) {
    h ^= s.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type LayoutTile = {
  id: string;
  /** Unscaled box size — the caller passes boxWidth/boxHeight straight off the WordTile. */
  boxWidth: number;
  boxHeight: number;
};

export type LayoutLink = { from: string; to: string };

export type LayoutOpts = {
  /** Canvas width. */
  width: number;
  /** Top of the play band (below the corner controls). */
  top: number;
  /** Bottom of the play band (above the keyboard). */
  bottom: number;
  /** Shared tile scale for the current canvas. */
  scale: number;
  /** Gap kept between a tile edge and the canvas/band edge. */
  margin: number;
  /** Injectable RNG (defaults to Math.random) — only used to break exact ties. */
  rand?: () => number;
};

/** Clear space we try to keep between two tile boxes (on top of their half-extents). */
const SEP_GAP = 26;
/** Edge-gap band a linked pair is sprung toward, plus a REST target they settle onto inside it.
 *  The numbers are tied to the chain's opacity ramp: the rope arc ≈ edge-gap − 28 (each end
 *  attaches TILE_GAP≈14 outside its tile), and the label chip only reaches full opacity at
 *  arc ≈ 105 (see Chain.update). So a pair must rest well past that — REST≈155 gives arc≈127,
 *  a solidly-lit label — and even the MIN floor (arc≈102) stays only a hair below full. Without
 *  the REST pull the band was "dead" (no force inside it), letting pairs rest at the fade knee. */
const LINK_MIN = 130;
const LINK_REST = 155;
const LINK_MAX = 215;
const ITERS = 260;
/** Pull toward the play-band centre — enough to float the cluster off the edges, weak enough
 *  that the link springs can still spread the tiles out to use the vertical space. */
const CENTER_PULL = 0.005;
/**
 * Coulomb-style repulsion between EVERY pair of tiles (not just ones already overlapping).
 * The box-overlap separation below only fires once two tiles are already touching, which is
 * too late for a graph like a 4-cycle: two tiles that share both their neighbours (linked only
 * indirectly) feel no direct force keeping them apart, and the two link springs pulling them
 * toward the same shared neighbours can converge them onto nearly the same spot — a textbook
 * force-directed-layout collapse. A constant, everywhere-active repulsion (falls off with
 * distance, so it doesn't fight the springs once tiles are comfortably apart) gives every pair
 * a "personal space" bubble regardless of whether they're linked, which breaks that collapse.
 */
const REPEL_K = 2600;

type Node = { id: string; x: number; y: number; hw: number; hh: number };

/** Order the tiles by a breadth-first walk of the link graph from the most-connected word, so
 *  chained tiles come out adjacent in the seed stack (short ropes) and hubs sit near their
 *  members. Disconnected tiles trail in their original order. */
function bfsOrder(tiles: LayoutTile[], links: LayoutLink[]): LayoutTile[] {
  const adj = new Map<string, string[]>();
  for (const t of tiles) adj.set(t.id, []);
  for (const l of links) {
    adj.get(l.from)?.push(l.to);
    adj.get(l.to)?.push(l.from);
  }
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: LayoutTile[] = [];
  // Seeds, most-connected first, so each component starts from its hub.
  const seeds = [...tiles].sort((a, b) => (adj.get(b.id)!.length - adj.get(a.id)!.length));
  for (const seed of seeds) {
    if (seen.has(seed.id)) continue;
    const queue = [seed.id];
    seen.add(seed.id);
    while (queue.length) {
      const id = queue.shift()!;
      out.push(byId.get(id)!);
      for (const nb of adj.get(id)!) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  return out;
}

export function graphLayout(
  tiles: LayoutTile[],
  links: LayoutLink[],
  o: LayoutOpts
): Map<string, { x: number; y: number }> {
  const rand = o.rand ?? Math.random;
  const result = new Map<string, { x: number; y: number }>();
  if (tiles.length === 0) return result;

  const cx = o.width / 2;
  const cyMid = (o.top + o.bottom) / 2;

  // Seed: a centred vertical zig-zag in BFS order. A good start matters — the relaxation only
  // has to tidy it, not discover the whole arrangement, which keeps it stable and quick.
  const ordered = bfsOrder(tiles, links);
  const n = ordered.length;
  const bandH = o.bottom - o.top;
  const nodes: Node[] = ordered.map((t, i) => {
    const hw = (t.boxWidth / 2) * o.scale;
    const hh = (t.boxHeight / 2) * o.scale;
    const frac = n > 1 ? i / (n - 1) : 0.5;
    // A few px of seeded jitter keeps two tiles that share both neighbours (e.g. opposite
    // corners of a 4-cycle) from starting on an exact symmetry line, where equal-and-opposite
    // spring forces could otherwise cancel out the very push that's meant to separate them.
    return {
      id: t.id,
      x:
        cx +
        (i % 2 === 0 ? -1 : 1) * Math.min(o.width * 0.18, cx - hw - o.margin) +
        (rand() - 0.5) * 10,
      y: o.top + o.margin + hh + frac * (bandH - 2 * (o.margin + hh)) + (rand() - 0.5) * 10,
      hw,
      hh,
    };
  });

  const clampX = (nd: Node, x: number) => {
    const lo = o.margin + nd.hw;
    const hi = o.width - o.margin - nd.hw;
    return hi > lo ? Phaser.Math.Clamp(x, lo, hi) : cx;
  };
  const clampY = (nd: Node, y: number) => {
    const lo = o.top + o.margin + nd.hh;
    const hi = o.bottom - o.margin - nd.hh;
    return hi > lo ? Phaser.Math.Clamp(y, lo, hi) : cyMid;
  };

  for (let iter = 0; iter < ITERS; iter++) {
    // Cooling: big nudges early to untangle, small ones late to settle.
    const temp = 1 - iter / ITERS;
    const dispX = new Array(n).fill(0);
    const dispY = new Array(n).fill(0);

    // Repulsion — EVERY pair pushes apart, falling off with distance, whether or not they're
    // linked or currently overlapping. This is what gives two tiles that only share neighbours
    // (no direct spring between them) a reason to keep clear of each other (see REPEL_K).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = b.x - a.x || (rand() - 0.5) * 2;
        const dy = b.y - a.y || (rand() - 0.5) * 2;
        const dist = Math.max(Math.hypot(dx, dy), 8);
        const f = REPEL_K / (dist * dist);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        dispX[i] -= fx;
        dispY[i] -= fy;
        dispX[j] += fx;
        dispY[j] += fy;
      }
    }

    // Separation — push apart any pair whose (gap-inflated) boxes overlap, along the axis of
    // least penetration so tiles slide neatly beside/below each other rather than jittering.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = a.hw + b.hw + SEP_GAP - Math.abs(dx);
        const oy = a.hh + b.hh + SEP_GAP - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const s = (dx === 0 ? (rand() < 0.5 ? -1 : 1) : Math.sign(dx)) * (ox / 2);
            dispX[i] -= s;
            dispX[j] += s;
          } else {
            const s = (dy === 0 ? (rand() < 0.5 ? -1 : 1) : Math.sign(dy)) * (oy / 2);
            dispY[i] -= s;
            dispY[j] += s;
          }
        }
      }
    }

    // Link springs — hold each chained pair in the [LINK_MIN, LINK_MAX] edge-gap band.
    for (const l of links) {
      const i = nodes.findIndex((nd) => nd.id === l.from);
      const j = nodes.findIndex((nd) => nd.id === l.to);
      if (i < 0 || j < 0) continue;
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      // Axis-aligned edge separation (negative if the boxes overlap).
      const gap = Math.max(Math.abs(dx) - (a.hw + b.hw), Math.abs(dy) - (a.hh + b.hh));
      let pull = 0;
      if (gap > LINK_MAX) pull = (gap - LINK_MAX) * 0.5;
      else if (gap < LINK_MIN) pull = (gap - LINK_MIN) * 0.5; // negative → push apart
      // Inside the band, a gentle pull toward REST so pairs seat at a label-legible distance
      // instead of drifting to the close edge and resting half-faded. Soft (0.08) so a hub with
      // several links can still compromise between them.
      else pull = (gap - LINK_REST) * 0.08;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      dispX[i] += fx;
      dispY[i] += fy;
      dispX[j] -= fx;
      dispY[j] -= fy;
    }

    // Soft pull to centre so the whole cluster floats in the middle of the band, not an edge.
    for (let i = 0; i < n; i++) {
      dispX[i] += (cx - nodes[i]!.x) * CENTER_PULL;
      dispY[i] += (cyMid - nodes[i]!.y) * CENTER_PULL;
    }

    // Integrate with a capped, cooling step, then clamp inside the play band.
    for (let i = 0; i < n; i++) {
      const nd = nodes[i]!;
      const cap = 40 * temp + 4;
      nd.x = clampX(nd, nd.x + Phaser.Math.Clamp(dispX[i]! * 0.6, -cap, cap));
      nd.y = clampY(nd, nd.y + Phaser.Math.Clamp(dispY[i]! * 0.6, -cap, cap));
    }
  }

  // Final separation-only relaxation so no two tiles are left overlapping even if a cramped
  // board couldn't satisfy every spring. Every conflicting pair's push is accumulated and
  // applied together each round (rather than resolved one pair at a time, which on a 4+ tile
  // board can undo a just-fixed pair while settling the next) — runs until clean or the cap.
  for (let pass = 0; pass < 60; pass++) {
    const dispX = new Array(n).fill(0);
    const dispY = new Array(n).fill(0);
    let anyOverlap = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = a.hw + b.hw + SEP_GAP - Math.abs(dx);
        const oy = a.hh + b.hh + SEP_GAP - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          anyOverlap = true;
          if (ox < oy) {
            const s = (dx === 0 ? (rand() < 0.5 ? -1 : 1) : Math.sign(dx)) * (ox / 2);
            dispX[i] -= s;
            dispX[j] += s;
          } else {
            const s = (dy === 0 ? (rand() < 0.5 ? -1 : 1) : Math.sign(dy)) * (oy / 2);
            dispY[i] -= s;
            dispY[j] += s;
          }
        }
      }
    }
    if (!anyOverlap) break;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i]!;
      nd.x = clampX(nd, nd.x + dispX[i]!);
      nd.y = clampY(nd, nd.y + dispY[i]!);
    }
  }

  for (const nd of nodes) result.set(nd.id, { x: nd.x, y: nd.y });
  return result;
}
