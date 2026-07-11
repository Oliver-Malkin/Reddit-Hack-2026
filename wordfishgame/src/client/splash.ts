/**
 * The inline feed splash — the face of every WordFish post scrolling past in the feed.
 *
 * This runs in the lightweight `inline: true` webview, so no Phaser: the whole scene is
 * painted once onto a static <canvas> in the same Memphis language as the game (grid,
 * squiggles, floating shapes with projected shadows, the rotating title treatments, the
 * word-tile look). Everything is seeded from the post id, so each post gets its own stable
 * arrangement — two WordFish posts never look identical in the feed.
 *
 * Two variants, resolved via /api/init (same contract the game uses, see puzzle/remote.ts):
 *  - DAILY  — big brand title in a seeded Memphis treatment, tagline, date, PLAY tile.
 *  - CUSTOM — brand + "COMMUNITY PUZZLE" tag, the puzzle's title and author, and a real
 *    render of the puzzle graph (tiles + chain glyphs + label chips) so the feed shows
 *    exactly what you'd be solving.
 *
 * Local preview: `npx vite src/client` then open /splash.html — add `?demoCustom=1` (or
 * `?demoCustom=big`) to force the community variant without a server.
 */

import { context, requestExpandedMode } from '@devvit/web/client';
import type { LinkType, Puzzle } from '../shared/puzzle';
import type { InitResponse } from '../shared/api';

// ---------------------------------------------------------------------------------------
// Palette (mirrors src/client/theme.ts — kept literal here so the inline bundle stays lean)
// ---------------------------------------------------------------------------------------

const C = {
  offWhite: '#f2f0e9',
  gridLine: '#dcd8cd',
  pink: '#ff2f8f',
  cyan: '#2ec4d6',
  yellow: '#f5b727',
  navy: '#2b2d6e',
  green: '#27ae60',
  purple: '#8e44ad',
  red: '#ef3b3b',
  ink: '#1c1c1c',
  white: '#ffffff',
} as const;

const UI_FONT = '"Arial Black", "Arial Bold", Arial, sans-serif';
const TAU = Math.PI * 2;
const FOREGROUND = [C.pink, C.cyan, C.yellow, C.navy, C.green, C.purple];
const SQUIGGLE_COLORS = [C.pink, C.cyan, C.yellow, C.red, C.ink];

// ---------------------------------------------------------------------------------------
// Seeded RNG — same mulberry32 as BackgroundScene, seeded from the post id so every post
// draws a different (but stable) splash.
// ---------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Rng = () => number;
const between = (rng: Rng, min: number, max: number) => rng() * (max - min) + min;
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------
// Background — static port of BackgroundScene's grid + squiggles + floating shapes.
// ---------------------------------------------------------------------------------------

function paintGrid(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle = C.offWhite;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cell = 60;
  for (let x = 0.5; x <= W; x += cell) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 0.5; y <= H; y += cell) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

/** Stroke an open polyline with round caps/joins (matches the game's squiggle strokes). */
function strokePoly(ctx: CanvasRenderingContext2D, color: string, width: number, pts: number[]) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.stroke();
}

/** The game's confetti motifs, drawn centred at the origin. */
const SQUIGGLES: ((ctx: CanvasRenderingContext2D, col: string) => void)[] = [
  (c, col) => strokePoly(c, col, 4, [-10, 7, -3, -7, 4, 7, 11, -7]), // zigzag
  (c, col) => {
    c.lineWidth = 3;
    c.strokeStyle = col;
    c.beginPath();
    c.arc(0, 0, 6, 0, TAU);
    c.stroke();
  }, // ring
  (c, col) => {
    c.fillStyle = col;
    for (let r = 0; r < 2; r++)
      for (let q = 0; q < 2; q++) {
        c.beginPath();
        c.arc(-4 + q * 8, -4 + r * 8, 2.5, 0, TAU);
        c.fill();
      }
  }, // dots
  (c, col) => {
    strokePoly(c, col, 2.5, [0, -7, 0, 7]);
    strokePoly(c, col, 2.5, [-7, 0, 7, 0]);
    strokePoly(c, col, 2.5, [-5, -5, 5, 5]);
    strokePoly(c, col, 2.5, [5, -5, -5, 5]);
  }, // spark
  (c, col) => {
    strokePoly(c, col, 3.5, [0, -7, 0, 7]);
    strokePoly(c, col, 3.5, [-7, 0, 7, 0]);
  }, // plus
  (c, col) => strokePoly(c, col, 3.5, [-4, 7, 5, -7]), // slash
  (c, col) => {
    c.fillStyle = col;
    c.beginPath();
    c.arc(0, 0, 3.5, 0, TAU);
    c.fill();
  }, // dot
  (c, col) => {
    const pts: number[] = [];
    for (let x = 0; x <= 24; x++) pts.push(-12 + x, Math.sin((x / 24) * Math.PI * 3) * 4);
    strokePoly(c, col, 3, pts);
  }, // wave
];

function paintSquiggles(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  rng: Rng,
  avoid: Rect[]
) {
  // Denser than before: the small confetti reads as texture, not clutter, and fills the
  // empty pockets a culled shape grid leaves behind — especially on busy puzzle cards.
  const target = Math.max(14, Math.round((W * H) / 17_000));
  const cols = Math.ceil(Math.sqrt((target * W) / H));
  const rows = Math.ceil(target / cols);
  const cw = W / cols;
  const ch = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      if (rng() < 0.08) continue;
      // Even a small mark through a line of text hurts it (an ✕ across the date reads
      // as a strikethrough) — retry a few spots in this cell, skip if none is clear.
      let x = 0;
      let y = 0;
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        x = q * cw + between(rng, 0.1, 0.9) * cw;
        y = r * ch + between(rng, 0.1, 0.9) * ch;
        ok = !avoid.some(
          (a) => x > a.x - 18 && x < a.x + a.w + 18 && y > a.y - 18 && y < a.y + a.h + 18
        );
      }
      if (!ok) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(between(rng, 0, TAU));
      ctx.scale(between(rng, 0.9, 1.3), between(rng, 0.9, 1.3));
      ctx.globalAlpha = 0.85;
      pick(rng, SQUIGGLES)(ctx, pick(rng, SQUIGGLE_COLORS));
      ctx.restore();
    }
  }
}

type ShapeType = 'rect' | 'triangle' | 'circle' | 'diamond' | 'pill' | 'semi';
type Rect = { x: number; y: number; w: number; h: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function traceShape(ctx: CanvasRenderingContext2D, type: ShapeType, size: number) {
  const half = size / 2;
  ctx.beginPath();
  switch (type) {
    case 'rect':
      ctx.roundRect(-half, -half, size, size, size * 0.16);
      break;
    case 'circle':
      ctx.arc(0, 0, half, 0, TAU);
      break;
    case 'diamond': {
      const side = size * 0.72;
      ctx.save();
      ctx.rotate(Math.PI / 4);
      ctx.roundRect(-side / 2, -side / 2, side, side, side * 0.12);
      ctx.restore();
      break;
    }
    case 'pill':
      ctx.roundRect(-half, -half * 0.6, size, size * 0.6, size * 0.3);
      break;
    case 'semi':
      ctx.arc(0, 0, half, Math.PI, 0, false);
      ctx.closePath();
      break;
    case 'triangle':
      ctx.moveTo(0, -half);
      ctx.lineTo(half, half);
      ctx.lineTo(-half, half);
      ctx.closePath();
      break;
  }
}

type ShapeSpec = {
  type: ShapeType;
  color: string;
  size: number;
  rot: number;
  outline: boolean;
  detail: 'none' | 'dots' | 'stripes';
  throwPx: number;
};

/** Roll one shape's appearance (type/colour supplied). */
function rollShape(rng: Rng, type: ShapeType, color: string, size: number): ShapeSpec {
  const outline = rng() < 0.14;
  return {
    type,
    color,
    size,
    rot: between(rng, 0, TAU),
    outline,
    detail: !outline && rng() < 0.35 ? (rng() < 0.5 ? 'dots' : 'stripes') : 'none',
    throwPx: 6 + between(rng, 4, 16), // shadow projection, light off the top-left
  };
}

/** Paint one floating shape (ground shadow + body + optional pattern) centred at (x, y). */
function drawShape(ctx: CanvasRenderingContext2D, x: number, y: number, s: ShapeSpec) {
  // Ground shadow, thrown down-right — matches what the body actually renders: a solid
  // shape casts a filled silhouette, an outline shape casts only a ring (the game's
  // BackgroundScene does the same — see its shadow-baking comment).
  ctx.save();
  ctx.translate(x + s.throwPx, y + s.throwPx);
  ctx.rotate(s.rot);
  ctx.globalAlpha = 0.16;
  traceShape(ctx, s.type, s.size);
  if (s.outline) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  } else {
    ctx.fillStyle = C.ink;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(s.rot);
  traceShape(ctx, s.type, s.size);
  if (s.outline) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = s.color;
    ctx.stroke();
  } else {
    ctx.fillStyle = s.color;
    ctx.fill();
    if (s.detail !== 'none') {
      ctx.save();
      traceShape(ctx, s.type, s.size);
      ctx.clip();
      const half = s.size / 2;
      if (s.detail === 'dots') {
        ctx.fillStyle = 'rgba(28,28,28,0.28)';
        const sp = s.size / 5;
        for (let yy = -half; yy < half; yy += sp)
          for (let xx = -half; xx < half; xx += sp) {
            ctx.beginPath();
            ctx.arc(xx + sp / 2, yy + sp / 2, sp * 0.32, 0, TAU);
            ctx.fill();
          }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        const sw = s.size / 8;
        for (let xx = -half; xx < half; xx += sw * 2) ctx.fillRect(xx, -half, sw, s.size);
      }
      ctx.restore();
    }
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.ink;
    traceShape(ctx, s.type, s.size);
    ctx.stroke();
  }
  ctx.restore();
}

/** True if a shape of `size` centred at (x, y) clears every content zone (its bbox plus
 *  shadow throw). */
function shapeClears(x: number, y: number, size: number, avoid: Rect[]): boolean {
  const half = size * 0.5 + 8;
  const bbox: Rect = { x: x - half, y: y - half, w: half * 2, h: half * 2 };
  return !avoid.some((a) => intersects(bbox, a));
}

/** A shuffled deck of every (type, colour) combo, so no two shapes on one splash match. */
function shapeDeck(rng: Rng): { type: ShapeType; color: string }[] {
  const types: ShapeType[] = ['rect', 'triangle', 'circle', 'diamond', 'pill', 'semi'];
  const combos: { type: ShapeType; color: string }[] = [];
  for (const t of types) for (const col of FOREGROUND) combos.push({ type: t, color: col });
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = combos[i]!;
    combos[i] = combos[j]!;
    combos[j] = tmp;
  }
  return combos;
}

/**
 * The game's floating shapes, frozen mid-drift with their projected shadows. `avoid` marks
 * the content zones: the game's UI floats above a moving field, but on a static card a big
 * shape parked under the text reads as noise — so shapes only land where they clear it.
 */
function paintShapes(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  rng: Rng,
  avoid: Rect[],
  deck: { type: ShapeType; color: string }[]
) {
  const count = Math.max(5, Math.round((W * H) / 90_000) + 3);
  const cols = Math.ceil(Math.sqrt((count * W) / H));
  const rows = Math.ceil(count / cols);
  const cw = W / cols;
  const ch = H / rows;

  let n = 0;
  for (let r = 0; r < rows && n < count; r++) {
    for (let q = 0; q < cols && n < count; q++) {
      const combo = deck[n % deck.length]!;
      const size = rng() < 0.2 ? between(rng, 120, 165) : between(rng, 60, 110);

      // Try a few jittered spots in this grid cell; skip if none clears the content.
      let x = 0;
      let y = 0;
      let ok = false;
      for (let attempt = 0; attempt < 8 && !ok; attempt++) {
        x = q * cw + between(rng, 0.15, 0.85) * cw;
        y = r * ch + between(rng, 0.15, 0.85) * ch;
        ok = shapeClears(x, y, size, avoid);
      }
      n++;
      if (!ok) continue;
      drawShape(ctx, x, y, rollShape(rng, combo.type, combo.color, size));
    }
  }
}

/**
 * Guarantee a few big statement shapes hugging the frame, half-bleeding off the edge —
 * the interior grid gets heavily culled on busy screens (a tall puzzle column reserves the
 * whole middle), which left phone cards looking bare. Anchoring large shapes to the free
 * margins keeps the Memphis energy even when the centre is full. Anchors are pushed further
 * out until they clear the content, so they always land (worst case mostly off-screen).
 */
function paintEdgeShapes(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  rng: Rng,
  avoid: Rect[],
  deck: { type: ShapeType; color: string }[]
) {
  // Anchor + the outward push direction that moves it toward its edge/corner.
  const anchors: { x: number; y: number; dx: number; dy: number }[] = [
    { x: W * 0.06, y: H * 0.08, dx: -1, dy: -1 }, // top-left
    { x: W * 0.94, y: H * 0.09, dx: 1, dy: -1 }, // top-right
    { x: W * 0.05, y: H * 0.5, dx: -1, dy: 0 }, // left
    { x: W * 0.95, y: H * 0.52, dx: 1, dy: 0 }, // right
    { x: W * 0.08, y: H * 0.93, dx: -1, dy: 1 }, // bottom-left
    { x: W * 0.92, y: H * 0.91, dx: 1, dy: 1 }, // bottom-right
  ];
  // Shuffle so which corners get shapes varies per seed, then take a handful.
  for (let i = anchors.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [anchors[i], anchors[j]] = [anchors[j]!, anchors[i]!];
  }
  const wantEdge = W > H * 1.15 ? 5 : 4; // wide cards have more free margin to fill
  let placed = 0;
  let di = deck.length - 1; // draw from the tail so interior shapes keep the head
  for (const anchor of anchors) {
    if (placed >= wantEdge) break;
    const combo = deck[((di-- % deck.length) + deck.length) % deck.length]!;
    const size = between(rng, 130, 180);
    let x = anchor.x;
    let y = anchor.y;
    // Slide toward the edge until the (large) shape clears the content, up to mostly off.
    let ok = false;
    for (let step = 0; step < 10; step++) {
      if (shapeClears(x, y, size, avoid)) {
        ok = true;
        break;
      }
      x += anchor.dx * size * 0.22;
      y += anchor.dy * size * 0.22;
    }
    if (!ok) continue;
    drawShape(ctx, x, y, rollShape(rng, combo.type, combo.color, size));
    placed++;
  }
}

function paintBackground(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  rng: Rng,
  avoid: Rect[]
) {
  const deck = shapeDeck(rng);
  paintGrid(ctx, W, H);
  paintSquiggles(ctx, W, H, rng, avoid);
  // Big edge shapes first (behind the interior scatter), then the interior grid on top.
  paintEdgeShapes(ctx, W, H, rng, avoid, deck);
  paintShapes(ctx, W, H, rng, avoid, deck);
}

// ---------------------------------------------------------------------------------------
// Title treatments — static canvas ports of the game's rotating Memphis title styles
// (see puzzle/titleStyles.ts). Seeded pick, so each post wears a different one.
// ---------------------------------------------------------------------------------------

const BRAND = 'WordFish';
const TITLE_STYLES = [
  'longshadow',
  'blocky3d',
  'hollow',
  'rainbow',
  'stripy',
  'gradient',
  'spotty',
  'halftone',
  'waterline',
] as const;
type TitleStyle = (typeof TITLE_STYLES)[number];

/** Treatments that stay legible at small sizes — the patterned bakes (spotty, halftone…)
 *  turn to mush below ~36px, so the community card's small brand only picks from these. */
const SMALL_TITLE_STYLES: readonly TitleStyle[] = ['longshadow', 'blocky3d', 'rainbow', 'waterline'];

function titleFont(px: number): string {
  return `900 ${px}px ${UI_FONT}`;
}

/** Supersample factor for the baked (patterned) title canvases. Matched to the device so
 *  a dpr-3 phone doesn't get a 1× bake stretched to mush (the game bakes at 2× too). */
function bakeRes(): number {
  return Math.max(2, Math.min(3, Math.round(window.devicePixelRatio || 1)));
}

/** Fill the whole (offscreen) canvas via `fillBg`, keep only the letters, optional keyline.
 *  Painted at bakeRes()× and stamped back at logical size by drawBaked(). */
function clippedTitle(
  W: number,
  H: number,
  px: number,
  fillBg: (ctx: CanvasRenderingContext2D) => void,
  keyline?: boolean
): HTMLCanvasElement {
  const res = bakeRes();
  const c = document.createElement('canvas');
  c.width = W * res;
  c.height = H * res;
  const ctx = c.getContext('2d')!;
  ctx.scale(res, res);
  ctx.font = titleFont(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  fillBg(ctx);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#000';
  ctx.fillText(BRAND, W / 2, H / 2);
  ctx.globalCompositeOperation = 'source-over';
  if (keyline) {
    ctx.lineWidth = px * 0.05;
    ctx.strokeStyle = C.ink;
    ctx.strokeText(BRAND, W / 2, H / 2);
  }
  return c;
}

/** Stamp a supersampled bake centred at (x, y) at its logical size. */
function drawBaked(ctx: CanvasRenderingContext2D, baked: HTMLCanvasElement, x: number, y: number) {
  const res = bakeRes();
  const w = baked.width / res;
  const h = baked.height / res;
  ctx.drawImage(baked, x - w / 2, y - h / 2, w, h);
}

function dotField(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cell: number,
  frac: number,
  ox: number,
  oy: number
) {
  const r = cell * frac;
  for (let y = (oy % cell) - cell; y < H + cell; y += cell)
    for (let x = (ox % cell) - cell; x < W + cell; x += cell) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
}

/** Draw the WordFish brand centred at (x, y) in the given treatment. `size` is the font px. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  style: TitleStyle
) {
  ctx.save();
  ctx.font = titleFont(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const textW = ctx.measureText(BRAND).width;

  if (style === 'longshadow') {
    const step = size * 0.02;
    ctx.fillStyle = C.cyan;
    for (let o = 12; o >= 1; o--) ctx.fillText(BRAND, x + o * step, y + o * step);
    ctx.fillStyle = C.ink;
    ctx.fillText(BRAND, x, y);
  } else if (style === 'blocky3d') {
    const step = size * 0.021;
    ctx.fillStyle = C.ink;
    for (let o = 6; o >= 1; o--) ctx.fillText(BRAND, x + o * step, y + o * step);
    ctx.lineWidth = size * 0.035;
    ctx.strokeStyle = C.ink;
    ctx.strokeText(BRAND, x, y);
    ctx.fillStyle = C.yellow;
    ctx.fillText(BRAND, x, y);
  } else if (style === 'hollow') {
    ctx.lineWidth = size * 0.06;
    ctx.strokeStyle = C.ink;
    ctx.strokeText(BRAND, x, y);
  } else if (style === 'rainbow') {
    const colors = [C.pink, C.cyan, C.yellow, C.green, C.purple, C.red, C.navy, C.pink];
    let cx = x - textW / 2;
    ctx.textAlign = 'left';
    BRAND.split('').forEach((ch, i) => {
      const w = ctx.measureText(ch).width;
      ctx.lineWidth = size * 0.04;
      ctx.strokeStyle = C.ink;
      ctx.strokeText(ch, cx, y);
      ctx.fillStyle = colors[i]!;
      ctx.fillText(ch, cx, y);
      cx += w;
    });
  } else {
    // Baked patterned styles — painted on an offscreen canvas then stamped centred.
    const pad = size * 0.5;
    const W = Math.ceil(textW + pad * 2);
    const H = Math.ceil(size * 1.4 + pad);
    let baked: HTMLCanvasElement;
    if (style === 'stripy') {
      baked = clippedTitle(
        W,
        H,
        size,
        (c) => {
          c.fillStyle = C.yellow;
          c.fillRect(0, 0, W, H);
          c.save();
          c.translate(W / 2, H / 2);
          c.rotate(0.838);
          const sw = size * 0.19;
          const R = Math.hypot(W, H);
          c.fillStyle = C.pink;
          for (let sx = -R; sx < R; sx += 2 * sw) c.fillRect(sx, -R, sw, 2 * R);
          c.restore();
        },
        true
      );
    } else if (style === 'gradient') {
      baked = clippedTitle(
        W,
        H,
        size,
        (c) => {
          const g = c.createLinearGradient(0, 0, W, 0);
          g.addColorStop(0, C.pink);
          g.addColorStop(0.55, C.purple);
          g.addColorStop(1, C.cyan);
          c.fillStyle = g;
          c.fillRect(0, 0, W, H);
        },
        true
      );
    } else if (style === 'spotty') {
      baked = clippedTitle(
        W,
        H,
        size,
        (c) => {
          c.fillStyle = C.cyan;
          c.fillRect(0, 0, W, H);
          c.fillStyle = C.ink;
          dotField(c, W, H, size * 0.3, 0.3, 0, 0);
          dotField(c, W, H, size * 0.23, 0.26, size * 0.11, size * 0.08);
        },
        true
      );
    } else if (style === 'halftone') {
      baked = clippedTitle(W, H, size, (c) => {
        c.fillStyle = C.ink;
        const cell = size * 0.135;
        dotField(c, W, H, cell, 0.42, 0, 0);
        dotField(c, W, H, cell, 0.42, cell / 2, cell / 2);
      });
    } else {
      // waterline — ink letters half-dipped in a cyan zigzag wave.
      const res = bakeRes();
      const c = document.createElement('canvas');
      c.width = W * res;
      c.height = H * res;
      const b = c.getContext('2d')!;
      b.scale(res, res);
      b.font = titleFont(size);
      b.textAlign = 'center';
      b.textBaseline = 'middle';
      b.fillStyle = C.ink;
      b.fillText(BRAND, W / 2, H / 2);
      b.save();
      const baseY = H * 0.6;
      const amp = size * 0.05;
      const seg = 12;
      b.beginPath();
      b.moveTo(0, baseY);
      for (let i = 0; i <= seg; i++) b.lineTo((W * i) / seg, baseY + (i % 2 ? -amp : amp));
      b.lineTo(W, H);
      b.lineTo(0, H);
      b.closePath();
      b.clip();
      b.fillStyle = C.cyan;
      b.fillText(BRAND, W / 2, H / 2);
      b.restore();
      baked = c;
    }
    drawBaked(ctx, baked, x, y);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// Word tiles — static port of WordTile's look (white cells, thick ink border, offset
// shadow; hidden words render as pink "?" cells with fill-in underlines).
// ---------------------------------------------------------------------------------------

const CELL_W = 46;
const CELL_H = 58;
const TILE_RADIUS = 10;
const TILE_BORDER = 5;
const TILE_SHADOW = 6;

function tileWidth(word: string): number {
  return word.length * CELL_W + TILE_BORDER * 2;
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  word: string,
  hidden: boolean,
  s: number,
  rot = 0
) {
  const n = word.length;
  const w = tileWidth(word);
  const h = CELL_H;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(s, s);

  // Offset ink shadow.
  ctx.fillStyle = 'rgba(28,28,28,0.18)';
  ctx.beginPath();
  ctx.roundRect(-w / 2 + TILE_SHADOW, -h / 2 + TILE_SHADOW, w, h, TILE_RADIUS);
  ctx.fill();

  // Body + separators + border.
  ctx.fillStyle = C.white;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, TILE_RADIUS);
  ctx.fill();
  ctx.strokeStyle = 'rgba(28,28,28,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 1; i < n; i++) {
    const sx = -w / 2 + TILE_BORDER + i * CELL_W;
    ctx.moveTo(sx, -h / 2 + 7);
    ctx.lineTo(sx, h / 2 - 7);
  }
  ctx.stroke();
  ctx.lineWidth = TILE_BORDER;
  ctx.strokeStyle = C.ink;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, TILE_RADIUS);
  ctx.stroke();

  // Letters (or the hidden word's "?" cells + fill-in underlines).
  ctx.font = `900 28px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const lx = -w / 2 + TILE_BORDER + i * CELL_W + CELL_W / 2;
    if (hidden) {
      ctx.fillStyle = C.pink;
      ctx.fillText('?', lx, 1);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.roundRect(lx - CELL_W / 2 + 8, h / 2 - 11, CELL_W - 16, 3, 1.5);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = C.ink;
      ctx.fillText(word[i]!, lx, 1);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// Chains — the game's per-type link glyphs (see puzzle/Chain.ts bakeTextures), drawn as a
// static run of shapes along a bowed curve, plus the white label chip.
// ---------------------------------------------------------------------------------------

const CHIP_LABEL: Record<LinkType, string> = {
  synonym: 'SYNONYM',
  antonym: 'ANTONYM',
  hypernym: 'IS A ▸',
  anagram: 'ANAGRAM',
  meronym: 'PART OF ▸',
  lettersubset: 'LETTERS IN ▸',
  sequence: 'BECOMES ▸',
  rhyme: 'RHYMES',
};

/** Types whose glyphs point along the chain (from → to). */
const DIRECTIONAL = new Set<LinkType>(['hypernym', 'sequence', 'lettersubset', 'meronym']);

/** Draw one chain glyph centred at the origin (coordinates match Chain.bakeTextures). */
function drawChainGlyph(ctx: CanvasRenderingContext2D, type: LinkType) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const coin = (fill: string) => {
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  };
  const bar = (fill: string, y: number) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(-5.5, y, 11, 2.6, 1.3);
    ctx.fill();
  };
  switch (type) {
    case 'synonym': // white coin stamped "="
      coin(C.white);
      bar(C.ink, -3.6);
      bar(C.ink, 1.0);
      break;
    case 'antonym': // ink coin, white "≠"
      coin(C.ink);
      bar(C.white, -3.6);
      bar(C.white, 1.0);
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-3.6, 6.8);
      ctx.lineTo(3.6, -6.8);
      ctx.stroke();
      break;
    case 'hypernym': {
      // yellow chevron pointing +x
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-5.5, -8.5);
        ctx.lineTo(7, 0);
        ctx.lineTo(-5.5, 8.5);
      };
      path();
      ctx.lineWidth = 8;
      ctx.strokeStyle = C.ink;
      ctx.stroke();
      path();
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = C.yellow;
      ctx.stroke();
      break;
    }
    case 'anagram': {
      // cyan coin with a "⟳" mix glyph
      coin(C.cyan);
      ctx.strokeStyle = C.ink;
      ctx.fillStyle = C.ink;
      ctx.lineWidth = 2.2;
      const r = 5.2;
      const arrowArc = (a0: number, a1: number) => {
        ctx.beginPath();
        ctx.arc(0, 0, r, a0, a1);
        ctx.stroke();
        const hx = Math.cos(a1) * r;
        const hy = Math.sin(a1) * r;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(a1 + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(3, 0);
        ctx.lineTo(-1.6, 2.3);
        ctx.lineTo(-1.6, -2.3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      arrowArc(-2.5, -0.6);
      arrowArc(-2.5 + Math.PI, -0.6 + Math.PI);
      break;
    }
    case 'meronym':
      // small purple part nosing into a larger outlined whole (+x side)
      ctx.beginPath();
      ctx.roundRect(2, -8, 10, 16, 3);
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(-12, -4, 8, 8, 2);
      ctx.fillStyle = C.purple;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(-0.5, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(2, 0);
      ctx.lineTo(-1, 2.1);
      ctx.lineTo(-1, -2.1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'lettersubset':
      // navy arrow flying INTO a bracket
      ctx.strokeStyle = C.navy;
      ctx.fillStyle = C.navy;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(2.5, -8);
      ctx.lineTo(8, -8);
      ctx.lineTo(8, 8);
      ctx.lineTo(2.5, 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-9.5, 0);
      ctx.lineTo(-0.5, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4.5, 0);
      ctx.lineTo(-1.5, 3.4);
      ctx.lineTo(-1.5, -3.4);
      ctx.closePath();
      ctx.fill();
      break;
    case 'sequence':
      // green arrowhead pointing +x
      ctx.beginPath();
      ctx.moveTo(-4, -7.5);
      ctx.lineTo(6.5, 0);
      ctx.lineTo(-4, 7.5);
      ctx.closePath();
      ctx.fillStyle = C.green;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.ink;
      ctx.stroke();
      break;
    case 'rhyme':
      // pink sound-wave arcs
      ctx.strokeStyle = C.pink;
      ctx.lineWidth = 2.6;
      for (const r of [4, 8, 12]) {
        ctx.beginPath();
        ctx.arc(-7, 0, r, -0.8, 0.8);
        ctx.stroke();
      }
      ctx.fillStyle = C.pink;
      ctx.beginPath();
      ctx.arc(-7, 0, 1.8, 0, TAU);
      ctx.fill();
      break;
  }
}

type PlacedTile = { x: number; y: number; w: number; h: number; rot: number };

/** Quadratic-bezier point + tangent at t. */
function quadAt(
  x0: number,
  y0: number,
  mx: number,
  my: number,
  x1: number,
  y1: number,
  t: number
): { x: number; y: number; tx: number; ty: number } {
  const u = 1 - t;
  const x = u * u * x0 + 2 * u * t * mx + t * t * x1;
  const y = u * u * y0 + 2 * u * t * my + t * t * y1;
  const tx = 2 * u * (mx - x0) + 2 * t * (x1 - mx);
  const ty = 2 * u * (my - y0) + 2 * t * (y1 - my);
  return { x, y, tx, ty };
}

/** Distance from a tile's centre to its bbox edge along a unit direction. */
function edgeDistance(tile: PlacedTile, ux: number, uy: number): number {
  const tx = ux !== 0 ? tile.w / 2 / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const ty = uy !== 0 ? tile.h / 2 / Math.abs(uy) : Number.POSITIVE_INFINITY;
  return Math.min(tx, ty);
}

type ChainGeom = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mx: number;
  my: number;
  rope: number;
};

/** Resolve a chain's endpoints (just outside each tile) and bowed control point. Returns
 *  null for chains too short to draw. Computed once so the body + label passes agree. */
function chainGeom(a: PlacedTile, b: PlacedTile, s: number, bowSide: number): ChainGeom | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const gap = 10 * s;
  const t0 = edgeDistance(a, ux, uy) + gap;
  const t1 = edgeDistance(b, -ux, -uy) + gap;
  const x0 = a.x + ux * t0;
  const y0 = a.y + uy * t0;
  const x1 = b.x - ux * t1;
  const y1 = b.y - uy * t1;
  const rope = Math.hypot(x1 - x0, y1 - y0);
  if (rope < 22) return null;
  // Long chains bow harder, so a link that skips past other tiles arcs around them
  // instead of running straight underneath.
  const bow = clamp(rope * 0.18, 10, 88) * bowSide;
  const mx = (x0 + x1) / 2 - uy * bow;
  const my = (y0 + y1) / 2 + ux * bow;
  return { x0, y0, x1, y1, mx, my, rope };
}

/** The dotted rope + glyph shapes of a chain (drawn under the tiles). The game's chains
 *  read as connected because they move together; a static card needs the dotted line to
 *  tie the glyphs to their tiles. */
function drawChainBody(ctx: CanvasRenderingContext2D, type: LinkType, g: ChainGeom, s: number, rng: Rng) {
  const { x0, y0, x1, y1, mx, my, rope } = g;

  ctx.save();
  ctx.strokeStyle = 'rgba(28,28,28,0.3)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.setLineDash([0.1, 9]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(mx, my, x1, y1);
  ctx.stroke();
  ctx.restore();

  // Glyphs sit on the two flanks of the rope, leaving the middle band clear for the label.
  // The game renders these at ~26px (2× textures at 0.5), scaled by the layout. Shown once
  // the rope has real room — below that the label alone reads cleaner than glyph slivers.
  const glyphScale = clamp(s * 1.2, 0.68, 1.0);
  // Kept to a handful: a long chain spraying eight glyphs reads as noise, not a link.
  const count = rope < 56 ? 0 : clamp(Math.round(rope / 48), 2, 5);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    if (t > 0.37 && t < 0.63) continue; // leave air for the label chip
    const p = quadAt(x0, y0, mx, my, x1, y1, t);
    ctx.save();
    ctx.translate(p.x, p.y);
    if (DIRECTIONAL.has(type)) ctx.rotate(Math.atan2(p.ty, p.tx));
    else ctx.rotate(between(rng, -0.3, 0.3));
    // Sequence swells toward its destination — growth over time.
    const swell = type === 'sequence' ? 0.7 + 0.6 * t : 1;
    ctx.scale(glyphScale * swell, glyphScale * swell);
    drawChainGlyph(ctx, type);
    ctx.restore();
  }
}

/** Overlap area between two rects (0 if disjoint) — scores where a chip least covers tiles. */
function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/** The chain's label chip — drawn on TOP of the tiles so a long chain crossing a tile still
 *  shows its label. It slides along the curve to the spot that covers the fewest tile
 *  letters (mirroring the game's chip, which dodges words), preferring the middle. */
function drawChainLabel(
  ctx: CanvasRenderingContext2D,
  type: LinkType,
  g: ChainGeom,
  s: number,
  rng: Rng,
  tiles: PlacedTile[]
) {
  if (g.rope <= 30) return;
  const label = CHIP_LABEL[type];
  const chipScale = clamp(s * 1.4, 0.72, 1);
  ctx.font = `800 12px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 24;
  const h = 26;
  const halfW = (w * chipScale) / 2;
  const halfH = (h * chipScale) / 2;

  // Search a band around the midpoint for the position that overlaps tiles least; ties
  // (and the common no-overlap case) fall to the point nearest 0.5.
  let best = quadAt(g.x0, g.y0, g.mx, g.my, g.x1, g.y1, 0.5);
  let bestCost = Infinity;
  for (let k = 0; k <= 8; k++) {
    const u = 0.28 + (0.44 * k) / 8;
    const p = quadAt(g.x0, g.y0, g.mx, g.my, g.x1, g.y1, u);
    const rect: Rect = { x: p.x - halfW, y: p.y - halfH, w: halfW * 2, h: halfH * 2 };
    let cost = Math.abs(u - 0.5) * 200; // gentle pull toward the centre
    for (const t of tiles) {
      cost += overlapArea(rect, { x: t.x - t.w / 2, y: t.y - t.h / 2, w: t.w, h: t.h }) * 3;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }

  ctx.save();
  ctx.translate(best.x, best.y);
  ctx.rotate(between(rng, -0.05, 0.05));
  ctx.scale(chipScale, chipScale);
  ctx.fillStyle = 'rgba(28,28,28,0.16)';
  ctx.beginPath();
  ctx.roundRect(-w / 2 + 3, -h / 2 + 4, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = C.white;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.ink;
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.fillText(label, 0, 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// Puzzle-graph layout. Words are first reordered so linked pairs sit next to each other,
// then placed either on an ellipse (wide areas) or a zigzag column (tall areas — phones).
// Both aim for a *comfortable* chain length rather than filling the area: three words
// scattered across a desktop-wide card read as unrelated, and tiles crammed together on a
// phone leave the chains nowhere to live.
// ---------------------------------------------------------------------------------------

/** Reorder words so that consecutive words share a link where possible — neighbouring
 *  placements then get short, clean chains instead of long ones across the middle. */
function orderByLinks(puzzle: Puzzle): Puzzle['words'] {
  const words = puzzle.words;
  if (words.length <= 2) return words.slice();
  const adj = new Map<string, Set<string>>();
  for (const w of words) adj.set(w.id, new Set());
  for (const l of puzzle.links) {
    adj.get(l.from)?.add(l.to);
    adj.get(l.to)?.add(l.from);
  }
  const byId = new Map(words.map((w) => [w.id, w]));
  const remaining = new Set(words.map((w) => w.id));
  // Start from an end of the link graph (lowest degree) so chains run along the path.
  let cur = words.reduce((a, b) => (adj.get(a.id)!.size <= adj.get(b.id)!.size ? a : b)).id;
  const order: string[] = [];
  while (remaining.size > 0) {
    order.push(cur);
    remaining.delete(cur);
    const next =
      [...(adj.get(cur) ?? [])].find((id) => remaining.has(id)) ??
      [...remaining].sort((a, b) => adj.get(a)!.size - adj.get(b)!.size)[0];
    if (!next) break;
    cur = next;
  }
  return order.map((id) => byId.get(id)!);
}

function layoutPuzzle(
  puzzle: Puzzle,
  area: { x: number; y: number; w: number; h: number },
  rng: Rng
): { tiles: Map<string, PlacedTile>; scale: number } {
  const words = orderByLinks(puzzle);
  // Tall, narrow area (a phone card): a zigzag column keeps rows tidy where an ellipse
  // degenerates into a cramped pillar with chains piling over each other.
  if (area.h > area.w * 1.15) return layoutColumn(words, area, rng);
  return layoutEllipse(words, area, rng);
}

/** Wide areas: tiles around an ellipse whose radii target a comfortable chain length
 *  (~a tile-width apart) instead of stretching to the card's edges. */
function layoutEllipse(
  words: Puzzle['words'],
  area: { x: number; y: number; w: number; h: number },
  rng: Rng
): { tiles: Map<string, PlacedTile>; scale: number } {
  const n = words.length;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const maxTileW = Math.max(...words.map((w) => tileWidth(w.text)));

  const jitter = words.map(() => between(rng, -0.12, 0.12));
  const rots = words.map(() => between(rng, -0.05, 0.05));

  const tryScale = (s: number): Map<string, PlacedTile> | null => {
    const rxMax = Math.max(0, area.w / 2 - (maxTileW * s) / 2 - 6);
    const ryMax = Math.max(0, area.h / 2 - (CELL_H * s) / 2 - 6);
    // Radius that puts neighbouring tile centres a tile-width + breathing room apart.
    const chord = maxTileW * s + 130 * s;
    const rIdeal = chord / (2 * Math.sin(Math.PI / Math.max(n, 2)));
    const rx = Math.min(rxMax, Math.max(rIdeal, maxTileW * s * 0.55));
    const ry = Math.min(ryMax, Math.max(rIdeal * 0.8, CELL_H * s * 1.8));
    const placed = new Map<string, PlacedTile>();
    const list: PlacedTile[] = [];
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (i / n) * TAU + jitter[i]!;
      const t: PlacedTile = {
        x: cx + rx * Math.cos(ang),
        y: cy + ry * Math.sin(ang),
        w: tileWidth(words[i]!.text) * s,
        h: CELL_H * s,
        rot: rots[i]!,
      };
      // Overlap check with generous margins: chains need air between tiles to show
      // their glyphs and label chip.
      for (const o of list) {
        if (
          Math.abs(t.x - o.x) < (t.w + o.w) / 2 + 54 &&
          Math.abs(t.y - o.y) < (t.h + o.h) / 2 + 40
        )
          return null;
      }
      list.push(t);
      placed.set(words[i]!.id, t);
    }
    return placed;
  };

  for (let s = 0.85; s >= 0.3; s -= 0.05) {
    const placed = tryScale(s);
    if (placed) return { tiles: placed, scale: s };
  }
  // Nothing fits cleanly — fall back to the column, which never overlaps.
  return layoutColumn(words, area, rng);
}

/** Tall areas: tiles stacked top-to-bottom, alternating left/right of centre so the
 *  chains run in short diagonals with room for a label chip between rows. */
function layoutColumn(
  words: Puzzle['words'],
  area: { x: number; y: number; w: number; h: number },
  rng: Rng
): { tiles: Map<string, PlacedTile>; scale: number } {
  const n = words.length;
  const cx = area.x + area.w / 2;

  const place = (s: number, gap: number): Map<string, PlacedTile> => {
    const totalH = n * CELL_H * s + (n - 1) * gap;
    let y = area.y + Math.max(0, (area.h - totalH) / 2) + (CELL_H * s) / 2;
    const placed = new Map<string, PlacedTile>();
    words.forEach((word, i) => {
      const w = tileWidth(word.text) * s;
      // Swing each row off-centre — as far as fits, up to a pleasant diagonal.
      const maxOff = Math.max(0, (area.w - w) / 2 - 8);
      const off = Math.min(maxOff, (52 + (i % 2) * 14) * s + between(rng, -8, 8));
      placed.set(word.id, {
        x: cx + (i % 2 === 0 ? -off : off),
        y,
        w,
        h: CELL_H * s,
        rot: between(rng, -0.05, 0.05),
      });
      y += CELL_H * s + gap;
    });
    return placed;
  };

  for (let s = 0.85; s >= 0.3; s -= 0.05) {
    const gap = 58 * s + 16; // room for glyphs + a chip between rows
    const fitsH = n * CELL_H * s + (n - 1) * gap <= area.h;
    const fitsW = words.every((w) => tileWidth(w.text) * s <= area.w - 12);
    if (fitsH && fitsW) return { tiles: place(s, gap), scale: s };
  }
  // Deep fallback: smallest tiles, compress the gaps to whatever the area allows.
  const s = 0.3;
  const gap = Math.max(24, (area.h - n * CELL_H * s) / Math.max(1, n - 1));
  return { tiles: place(s, gap), scale: s };
}

type PuzzleLayout = { tiles: Map<string, PlacedTile>; scale: number };

/** Tight bounding box of the laid-out tiles (plus chain clearance) — the background only
 *  needs to keep out of THIS, not the whole reserved area, so a compact column still gets
 *  decor above and below it. */
function graphBounds(layout: PuzzleLayout): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of layout.tiles.values()) {
    minX = Math.min(minX, t.x - t.w / 2);
    minY = Math.min(minY, t.y - t.h / 2);
    maxX = Math.max(maxX, t.x + t.w / 2);
    maxY = Math.max(maxY, t.y + t.h / 2);
  }
  const pad = 34; // room for chain bows + chips looping past the outermost tiles
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

function drawPuzzleGraph(ctx: CanvasRenderingContext2D, puzzle: Puzzle, layout: PuzzleLayout, rng: Rng) {
  const { tiles, scale } = layout;
  // Resolve each link's geometry once — alternating bow sides so parallel links separate.
  const chains = puzzle.links.map((link, i) => {
    const a = tiles.get(link.from);
    const b = tiles.get(link.to);
    const g = a && b ? chainGeom(a, b, scale, i % 2 === 0 ? 1 : -1) : null;
    return g ? { type: link.type, g } : null;
  });

  // Three passes so nothing important hides: ropes + glyphs UNDER the tiles, then the
  // tiles, then the label chips ON TOP (a long chain crossing a tile still shows its label).
  const tileList = [...tiles.values()];
  for (const c of chains) if (c) drawChainBody(ctx, c.type, c.g, scale, rng);
  for (const word of puzzle.words) {
    const t = tiles.get(word.id);
    if (t) drawTile(ctx, t.x, t.y, word.text, word.hidden === true, scale, t.rot);
  }
  for (const c of chains) if (c) drawChainLabel(ctx, c.type, c.g, scale, rng, tileList);
}

// ---------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  weight: string,
  color: string,
  letterSpacing = 0
) {
  ctx.save();
  ctx.font = `${weight} ${px}px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  try {
    if (letterSpacing) ctx.letterSpacing = `${letterSpacing}px`;
  } catch {
    /* older engines — spacing is cosmetic */
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** The three accent dots — the menu's quiet Memphis divider. */
function drawAccentDots(ctx: CanvasRenderingContext2D, x: number, y: number) {
  [C.pink, C.yellow, C.cyan].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x + (i - 1) * 18, y, 4, 0, TAU);
    ctx.fill();
  });
}

// ---------------------------------------------------------------------------------------
// Data — resolve whether this post is a community puzzle (mirrors puzzle/remote.ts).
// ---------------------------------------------------------------------------------------

type CustomData = { puzzle: Puzzle; title: string; author: string };

const DEMO_SMALL: CustomData = {
  title: 'Meteor Shower',
  author: 'demo_author',
  puzzle: {
    words: [
      { id: 'w1', text: 'METEOR' },
      { id: 'w2', text: 'REMOTE', hidden: true },
      { id: 'w3', text: 'DISTANT' },
    ],
    links: [
      { type: 'anagram', from: 'w1', to: 'w2' },
      { type: 'synonym', from: 'w2', to: 'w3' },
    ],
  },
};

const DEMO_BIG: CustomData = {
  title: 'A Walk in the Woods',
  author: 'demo_author',
  puzzle: {
    words: [
      { id: 'w1', text: 'ACORN' },
      { id: 'w2', text: 'TREE', hidden: true },
      { id: 'w3', text: 'FOREST' },
      { id: 'w4', text: 'BARK' },
      { id: 'w5', text: 'DARK', hidden: true },
      { id: 'w6', text: 'LIGHT' },
    ],
    links: [
      { type: 'sequence', from: 'w1', to: 'w2' },
      { type: 'meronym', from: 'w2', to: 'w3' },
      { type: 'meronym', from: 'w4', to: 'w2' },
      { type: 'rhyme', from: 'w4', to: 'w5' },
      { type: 'antonym', from: 'w5', to: 'w6' },
    ],
  },
};

async function resolveCustom(): Promise<CustomData | null> {
  try {
    const demo = new URLSearchParams(window.location.search).get('demoCustom');
    if (demo) return demo === 'big' ? DEMO_BIG : DEMO_SMALL;
  } catch {
    /* no search params in some webviews */
  }
  const timeout = new Promise<null>((res) => window.setTimeout(() => res(null), 1500));
  const fetched = (async (): Promise<CustomData | null> => {
    try {
      const res = await fetch('/api/init');
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<InitResponse>;
      if (data && data.puzzle) {
        return {
          puzzle: data.puzzle,
          title: data.puzzleTitle ?? 'A WordFish puzzle',
          author: data.puzzleAuthor ?? 'someone',
        };
      }
      return null;
    } catch {
      return null;
    }
  })();
  return Promise.race([fetched, timeout]);
}

// ---------------------------------------------------------------------------------------
// Scene composition
// ---------------------------------------------------------------------------------------

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const caption = document.getElementById('caption') as HTMLDivElement;

// Seed from the post id so this post's splash is stable but unlike any other post's.
let seedSource = '';
try {
  seedSource = context.postId ?? '';
} catch {
  /* outside Devvit */
}
const SEED = seedSource ? hashString(seedSource) : (Math.random() * 0xffffffff) >>> 0;

/** Build the PLAY button's letter cells (a DOM twin of the game's word tile). */
function buildPlayButton(word: string) {
  playBtn.textContent = '';
  for (const ch of word) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.textContent = ch;
    playBtn.appendChild(cell);
  }
}

function placeButton(cx: number, cy: number, s: number) {
  playBtn.style.fontSize = `${Math.round(28 * s)}px`;
  playBtn.style.left = `${cx}px`;
  playBtn.style.top = `${cy}px`;
  caption.style.left = `${cx}px`;
  caption.style.top = `${cy + (CELL_H / 2) * s + 18}px`;
}

/** e.g. "THURSDAY 9 JULY" — reinforces that the pinned post is a fresh daily level. */
function todayLabel(): string {
  try {
    return new Date()
      .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
      .toUpperCase();
  } catch {
    return 'TODAY';
  }
}

function render(custom: CustomData | null, variantKnown: boolean) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Cap at 3 (not 2): a dpr-3 phone rendered from a 2× buffer reads as soft text. The
  // paint is a one-off static frame, so the extra pixels cost nothing per-frame.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const rng = mulberry32(SEED);
  // Pick the title treatment up front: paintShapes consumes a variable number of rng
  // draws (position retries), so picking after it would reshuffle the title between the
  // pre-fetch paint and the final one.
  const titleStyle = pick(rng, TITLE_STYLES);
  const cx = W / 2;

  if (!variantKnown) {
    // First paint while /api/init resolves: background + brand only, no variant text —
    // so a community post never flashes the daily pitch.
    const size = clamp(Math.round(W * 0.13), 36, 84);
    paintBackground(ctx, W, H, rng, [
      { x: cx - W * 0.44, y: H * 0.42 - size * 0.7, w: W * 0.88, h: size * 1.4 },
    ]);
    drawTitle(ctx, cx, H * 0.42, size, titleStyle);
    playBtn.style.visibility = 'hidden';
    caption.style.visibility = 'hidden';
    return;
  }

  playBtn.style.visibility = 'visible';
  caption.style.visibility = 'visible';

  if (!custom) {
    // ---- DAILY ----
    // Layout first (so the background knows where the content sits), then paint.
    const size = clamp(Math.round(W * 0.145), 40, 96);
    const titleY = clamp(H * 0.26, size * 0.7, H * 0.34);
    const taglineY = titleY + size * 0.62 + 16;
    const dotsY = taglineY + 24;
    const dateY = dotsY + 26;
    const btnScale = clamp(W / 440, 0.72, 1.05);
    const btnY = clamp(
      (dateY + 20 + (H - 24)) / 2,
      dateY + 40 + (CELL_H / 2) * btnScale,
      H - 78
    );
    const btnW = (4 * CELL_W + 10) * btnScale;

    paintBackground(ctx, W, H, rng, [
      // Title through date — one tall central block.
      { x: cx - W * 0.44, y: titleY - size * 0.75, w: W * 0.88, h: dateY + 16 - (titleY - size * 0.75) },
      // The PLAY tile + its caption.
      { x: cx - btnW / 2 - 14, y: btnY - (CELL_H / 2) * btnScale - 12, w: btnW + 28, h: CELL_H * btnScale + 52 },
    ]);

    drawTitle(ctx, cx, titleY, size, titleStyle);
    drawText(ctx, 'A DAILY WORD PUZZLE', cx, taglineY, clamp(Math.round(W * 0.032), 12, 17), '800', C.navy, 3);
    drawAccentDots(ctx, cx, dotsY);
    drawText(ctx, todayLabel(), cx, dateY, 12, '700', '#6a6a6a', 1);

    placeButton(cx, btnY, btnScale);
    caption.textContent = 'TAP TO PLAY';
  } else {
    // ---- COMMUNITY PUZZLE ----
    // Layout first: brand, tag, puzzle title, author, then the graph fills the middle.
    const brandSize = clamp(Math.round(W * 0.062), 22, 36);
    const brandY = clamp(H * 0.065, brandSize * 0.7, 44);
    const tagY = brandY + brandSize * 0.62 + 12;
    const tagSize = clamp(Math.round(W * 0.028), 11, 14);

    const rawTitle = custom.title.toUpperCase();
    let titlePx = clamp(Math.round(W * 0.062), 16, rawTitle.length > 16 ? 24 : 32);
    ctx.font = `900 ${titlePx}px ${UI_FONT}`;
    while (titlePx > 13 && ctx.measureText(rawTitle).width > W - 32) {
      titlePx -= 1;
      ctx.font = `900 ${titlePx}px ${UI_FONT}`;
    }
    const titleY = tagY + 20 + titlePx * 0.6;
    const authorY = titleY + titlePx * 0.6 + 12;
    const authorText = `by u/${custom.author}`;
    const authorSize = clamp(Math.round(W * 0.03), 12, 15);

    const btnScale = clamp(W / 470, 0.66, 0.9);
    const btnH = CELL_H * btnScale;
    const btnY = H - 26 - btnH / 2 - 14;
    const btnW = (4 * CELL_W + 10) * btnScale;
    const areaTop = authorY + 22;
    const area = { x: 14, y: areaTop, w: W - 28, h: btnY - btnH / 2 - 18 - areaTop };

    // Lay the puzzle out BEFORE painting the background, so the decor only avoids the
    // graph's actual footprint — a compact column still gets shapes above and below it.
    const layout = area.h > 60 ? layoutPuzzle(custom.puzzle, area, rng) : null;

    // The header text (brand, tag, title, author) is usually much narrower than the daily
    // menu's — a fixed 0.88W-wide avoid box left big dead flanks on wide cards with nothing
    // above the puzzle. Size the box to what's actually on screen instead: the widest line
    // plus generous padding for letter-spacing and font-metric slop.
    ctx.font = `900 ${brandSize}px ${UI_FONT}`;
    const brandW = ctx.measureText(BRAND).width;
    ctx.font = `900 ${tagSize}px ${UI_FONT}`;
    const tagW = ctx.measureText('COMMUNITY PUZZLE').width;
    ctx.font = `900 ${titlePx}px ${UI_FONT}`;
    const titleW = ctx.measureText(rawTitle).width;
    ctx.font = `700 ${authorSize}px ${UI_FONT}`;
    const authorW = ctx.measureText(authorText).width;
    const headerW = clamp(Math.max(brandW, tagW, titleW, authorW) + 64, 200, W * 0.88);

    paintBackground(ctx, W, H, rng, [
      // Header block (brand → author), sized to the actual text rather than a fixed span.
      { x: cx - headerW / 2, y: brandY - brandSize * 0.75, w: headerW, h: authorY + 10 - (brandY - brandSize * 0.75) },
      // The puzzle graph — keep its stage clear so the tiles + chains read instantly.
      ...(layout ? [graphBounds(layout)] : []),
      // The PLAY tile + caption.
      { x: cx - btnW / 2 - 14, y: btnY - btnH / 2 - 12, w: btnW + 28, h: btnH + 52 },
    ]);

    // Swap in a small-size-safe treatment if the seeded pick is a patterned bake.
    const brandStyle = SMALL_TITLE_STYLES.includes(titleStyle)
      ? titleStyle
      : SMALL_TITLE_STYLES[SEED % SMALL_TITLE_STYLES.length]!;
    drawTitle(ctx, cx, brandY, brandSize, brandStyle);
    drawText(ctx, 'COMMUNITY PUZZLE', cx, tagY, tagSize, '900', C.pink, 3);
    drawText(ctx, rawTitle, cx, titleY, titlePx, '900', C.ink);
    drawText(ctx, authorText, cx, authorY, authorSize, '700', C.navy);

    if (layout) drawPuzzleGraph(ctx, custom.puzzle, layout, rng);

    placeButton(cx, btnY, btnScale);
    caption.textContent = 'TAP TO SOLVE IT';
  }
}

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------

buildPlayButton('PLAY');

playBtn.addEventListener('click', (e) => {
  try {
    requestExpandedMode(e, 'game');
  } catch {
    /* outside Devvit (local preview) — nothing to expand */
  }
});

let resolved: CustomData | null = null;
let known = false;

render(null, false);
void resolveCustom().then((custom) => {
  resolved = custom;
  known = true;
  render(resolved, known);
});

// Re-render on any viewport change. Both hooks are needed: some webviews never fire
// window resize, and ResizeObserver covers those; the guard skips redundant repaints.
let lastW = window.innerWidth;
let lastH = window.innerHeight;
function onViewportChange() {
  if (window.innerWidth === lastW && window.innerHeight === lastH) return;
  lastW = window.innerWidth;
  lastH = window.innerHeight;
  render(resolved, known);
}
window.addEventListener('resize', onViewportChange);
new ResizeObserver(onViewportChange).observe(document.documentElement);
