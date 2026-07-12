import Phaser from 'phaser';
import { effectiveDpr } from '../hidpi';
import { paintOutlineRing } from '../textOutline';
import type { TextPainter } from '../textOutline';

/**
 * The home-screen "WordFish" title, in one of a rotating set of Memphis treatments. The
 * menu picks one at random each time it appears (see MenuScene), so the splash feels a
 * little different every visit.
 *
 * Two build strategies are used, picked per style by how it's drawn:
 *  - TEXT styles stack a few Phaser Text objects (fills and offsets only) inside a
 *    container. Cheap, crisp, resolution-independent — but reserved for styles with NO
 *    outline: text strokes are off-limits, because on phones the title font falls back to
 *    a variable font whose overlapping glyph contours make strokeText paint stray border
 *    fragments inside the letters (see textOutline.ts).
 *  - BAKED styles need a pattern the text engine can't fill (dots, stripes, gradients, a
 *    clipped waterline) or an outline ring (built via textOutline's masked-stroke trick),
 *    so they're painted to a supersampled canvas texture clipped to the letter shapes —
 *    the same trick the drifting background shapes use — and shown scaled back down.
 *
 * Every builder returns a Container centred on (x, y) with its pieces around the local
 * origin, so the caller can place, tween and rotate the whole title as one object.
 */

const WORD = 'WordFish';
const TITLE_FONT = '"Arial Black", "Arial Bold", Arial, sans-serif';
const TAU = Math.PI * 2;
/**
 * Bake-resolution multiplier: the texture is painted at RES× the cap-height and shown at
 * `1 / RES` scale, so it always occupies the same CSS size — RES only trades texture memory
 * for edge crispness.
 *
 * It has to be at least 2× the display density (the capped device pixel ratio), NOT a flat 2.
 * At a flat 2, a phone (dpr 2, its camera zoomed ×2) maps the texture 1:1 onto device pixels;
 * any sub-pixel offset then makes LINEAR filtering smear the thin ink keylines and letter
 * edges across two rows — the "broken borders" bug. Baking at `2 × dpr` keeps the on-screen
 * image minified ≥2:1 on every platform (the same supersampling desktop already gets), which
 * averages that offset away. Desktop (dpr 1) is unchanged at 2.
 */
function bakeRes(): number {
  return 2 * effectiveDpr();
}

const C = {
  ink: '#1c1c1c',
  board: '#f2f0e9',
  white: '#ffffff',
  pink: '#ff2f8f',
  cyan: '#2ec4d6',
  yellow: '#f5b727',
  navy: '#2b2d6e',
  green: '#27ae60',
  purple: '#8e44ad',
  red: '#ef3b3b',
} as const;

export const TITLE_STYLES = [
  'stripy',
  'wonky',
  'longshadow',
  'blocky3d',
  'rainbow',
  'cutout',
  'highlighter',
  'gradient',
  'spotty',
  'hollow',
  'halftone',
  'slats',
  'hatch',
  'waterline',
] as const;
export type TitleStyle = (typeof TITLE_STYLES)[number];

/** Pick a random title style for this menu appearance. */
export function pickTitleStyle(): TitleStyle {
  return TITLE_STYLES[Math.floor(Math.random() * TITLE_STYLES.length)]!;
}

/**
 * Build the WordFish title in `style`, as a container centred at (x, y). `size` is the
 * cap-height target (the game passes clamp(round(W*0.13), 44, 96)). The container's
 * `nominalHeight` (stashed as data) lets the caller lay the tagline out beneath it.
 */
export function buildTitle(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size: number,
  style: TitleStyle
): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  switch (style) {
    case 'longshadow':
      buildLongShadow(scene, c, size);
      break;
    case 'highlighter':
      buildHighlighter(scene, c, size);
      break;
    case 'cutout':
      buildCutout(scene, c, size);
      break;
    default:
      // Everything with an outline ring or a pattern fill is baked (see file header).
      buildBaked(scene, c, size, style);
      break;
  }
  // Distance from the container centre to the visible bottom of the title, so the caller
  // can drop the tagline just below it. Most treatments sit within the cap-height box;
  // ones with a backing card (cutout) set their own larger value.
  if (c.getData('halfHeight') == null) c.setData('halfHeight', size * 0.55);
  return c;
}

// ---------------------------------------------------------------------------
// TEXT styles
// ---------------------------------------------------------------------------

/** A single centred "WordFish" text in the title font. */
function word(scene: Phaser.Scene, size: number, color: string): Phaser.GameObjects.Text {
  return scene.add
    .text(0, 0, WORD, {
      fontFamily: TITLE_FONT,
      fontSize: `${size}px`,
      fontStyle: '900',
      color,
    })
    .setOrigin(0.5);
}

/** Ink letters raked into a flat cyan shadow down-right. */
function buildLongShadow(scene: Phaser.Scene, c: Phaser.GameObjects.Container, size: number) {
  const step = size * 0.02;
  for (let o = 12; o >= 1; o--) {
    c.add(word(scene, size, C.cyan).setPosition(o * step, o * step));
  }
  c.add(word(scene, size, C.ink));
}

/** Ink letters over a hand-swiped yellow marker band, whole thing tilted a touch. */
function buildHighlighter(scene: Phaser.Scene, c: Phaser.GameObjects.Container, size: number) {
  const t = word(scene, size, C.ink);
  const w = t.width;
  const h = t.height;
  const band = scene.add.graphics();
  band.fillStyle(Phaser.Display.Color.HexStringToColor(C.yellow).color, 1);
  band.fillRect(-w / 2 - size * 0.1, -h * 0.3, w + size * 0.2, h * 0.62);
  c.add([band, t]);
  c.setRotation(-0.026);
}

/** Off-white letters punched out of a pink card with an ink border + offset shadow. */
function buildCutout(scene: Phaser.Scene, c: Phaser.GameObjects.Container, size: number) {
  const t = word(scene, size, C.board);
  const cardW = t.width + size * 0.56;
  const cardH = t.height + size * 0.16;
  const r = size * 0.22;
  const g = scene.add.graphics();
  g.fillStyle(Phaser.Display.Color.HexStringToColor(C.ink).color, 0.25);
  g.fillRoundedRect(-cardW / 2 + size * 0.07, -cardH / 2 + size * 0.08, cardW, cardH, r);
  g.fillStyle(Phaser.Display.Color.HexStringToColor(C.pink).color, 1);
  g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, r);
  g.lineStyle(size * 0.06, Phaser.Display.Color.HexStringToColor(C.ink).color, 1);
  g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, r);
  c.add([g, t]);
  // The card's shadow is offset down-right by size*0.08, so its visible bottom edge sits
  // that much past cardH/2 — without accounting for it, the tagline reads as crowding the
  // shadow rather than sitting a clean gap below the card.
  c.setData('halfHeight', cardH / 2 + size * 0.08);
}

// ---------------------------------------------------------------------------
// BAKED styles (patterns, gradients, waterline, and every outlined style)
// ---------------------------------------------------------------------------

function buildBaked(
  scene: Phaser.Scene,
  c: Phaser.GameObjects.Container,
  size: number,
  style: TitleStyle
) {
  const key = `title-${style}-${size}`;
  bakeTitleTexture(scene, key, size, style);
  // Shown at 1 / RES so the RES× texture occupies the plain cap-height on screen.
  c.add(scene.add.image(0, 0, key).setOrigin(0.5).setScale(1 / bakeRes()));
}

/** Paint the title into a canvas texture, at 2× resolution. `draw` gets the context with
 *  the font, centre alignment and middle baseline already set, plus the canvas size and
 *  the pixel cap-height, and is responsible for the whole appearance. */
function bakeTitleTexture(scene: Phaser.Scene, key: string, size: number, style: TitleStyle) {
  if (scene.textures.exists(key)) return;

  const px = size * bakeRes();
  const font = `900 ${px}px ${TITLE_FONT}`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textW = measure.measureText(WORD).width;
  const pad = px * 0.5;
  const W = Math.ceil(textW + pad * 2);
  const H = Math.ceil(px * 1.4 + pad);

  const tex = scene.textures.createCanvas(key, W, H)!;
  const ctx = tex.context;
  ctx.clearRect(0, 0, W, H);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  BAKE_DRAW[style]!(ctx, W, H, px);
  tex.refresh();
}

/** A painter that strokes/fills the whole word centred on the canvas — the geometry most
 *  outline rings share. */
const wordPainter = (W: number, H: number): TextPainter => (c, mode) => {
  if (mode === 'stroke') c.strokeText(WORD, W / 2, H / 2);
  else c.fillText(WORD, W / 2, H / 2);
};

/** One per-letter slot in a centred row: each glyph advances by its own width (matching the
 *  old per-glyph Text layout), with optional rotation / vertical nudge for wonky. */
type GlyphSpot = { ch: string; x: number; y: number; rot: number };

function glyphSpots(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  wobble?: (i: number) => { rot: number; dy: number }
): GlyphSpot[] {
  const chars = WORD.split('');
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0);
  let cx = W / 2 - total / 2;
  return chars.map((ch, i) => {
    const wb = wobble?.(i) ?? { rot: 0, dy: 0 };
    const spot = { ch, x: cx + widths[i]! / 2, y: H / 2 + wb.dy, rot: wb.rot };
    cx += widths[i]!;
    return spot;
  });
}

function paintGlyph(c: CanvasRenderingContext2D, sp: GlyphSpot, mode: 'stroke' | 'fill') {
  c.save();
  c.translate(sp.x, sp.y);
  c.rotate(sp.rot);
  if (mode === 'stroke') c.strokeText(sp.ch, 0, 0);
  else c.fillText(sp.ch, 0, 0);
  c.restore();
}

/** Fill the whole canvas via `fillBg`, keep only the part inside the letters, then (option-
 *  ally) slot an ink keyline ring behind them. The shared skeleton for pattern / gradient
 *  fills. The keyline is a masked-stroke ring, NOT a strokeText — see textOutline.ts. */
function clippedFill(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  fillBg: () => void,
  keyline?: { w: number; color: string }
) {
  fillBg();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#000';
  ctx.fillText(WORD, W / 2, H / 2);
  ctx.globalCompositeOperation = 'source-over';
  if (keyline) paintOutlineRing(ctx, keyline.w, keyline.color, wordPainter(W, H));
}

/** Scatter dots across the whole canvas at a given cell size, radius fraction and offset. */
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
  for (let y = (oy % cell) - cell; y < H + cell; y += cell) {
    for (let x = (ox % cell) - cell; x < W + cell; x += cell) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  }
}

const BAKE_DRAW: Record<
  TitleStyle,
  (ctx: CanvasRenderingContext2D, W: number, H: number, px: number) => void
> = {
  // Diagonal pink/yellow candy stripes, thin ink keyline.
  stripy: (ctx, W, H, px) => {
    clippedFill(
      ctx,
      W,
      H,
      () => {
        ctx.fillStyle = C.yellow;
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(0.838); // ~48°
        const sw = px * 0.19;
        const R = Math.hypot(W, H);
        ctx.fillStyle = C.pink;
        for (let x = -R; x < R; x += 2 * sw) ctx.fillRect(x, -R, sw, 2 * R);
        ctx.restore();
      },
      { w: px * 0.05, color: C.ink }
    );
  },

  // Pink → purple → cyan sweep, thin ink keyline.
  gradient: (ctx, W, H, px) => {
    clippedFill(
      ctx,
      W,
      H,
      () => {
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, C.pink);
        g.addColorStop(0.55, C.purple);
        g.addColorStop(1, C.cyan);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      },
      { w: px * 0.05, color: C.ink }
    );
  },

  // Scattered ink polka dots over cyan (three offset layers break the grid), ink keyline.
  spotty: (ctx, W, H, px) => {
    clippedFill(
      ctx,
      W,
      H,
      () => {
        ctx.fillStyle = C.cyan;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = C.ink;
        dotField(ctx, W, H, px * 0.3, 0.3, 0, 0);
        dotField(ctx, W, H, px * 0.23, 0.26, px * 0.11, px * 0.08);
        dotField(ctx, W, H, px * 0.37, 0.22, px * 0.05, px * 0.15);
      },
      { w: px * 0.05, color: C.ink }
    );
  },

  // Dense ink dots, NO keyline — letters emerge from the dot field (two half-dropped layers).
  halftone: (ctx, W, H, px) => {
    clippedFill(ctx, W, H, () => {
      ctx.fillStyle = C.ink;
      const cell = px * 0.135;
      dotField(ctx, W, H, cell, 0.42, 0, 0);
      dotField(ctx, W, H, cell, 0.42, cell / 2, cell / 2);
    });
  },

  // Fine horizontal ink slats, NO keyline.
  slats: (ctx, W, H, px) => {
    clippedFill(ctx, W, H, () => {
      ctx.fillStyle = C.ink;
      // Thin gaps: the ink slats sit close together so most of each letter is filled.
      const h = px * 0.058;
      const step = px * 0.082;
      for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, h);
    });
  },

  // Diagonal ink hatching, NO keyline.
  hatch: (ctx, W, H, px) => {
    clippedFill(ctx, W, H, () => {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(-0.907); // ~-52°
      // Thin gaps between the ink hatch lines so more of each letter reads as filled.
      const h = px * 0.062;
      const step = px * 0.092;
      const R = Math.hypot(W, H);
      ctx.fillStyle = C.ink;
      for (let y = -R; y < R; y += step) ctx.fillRect(-R, y, 2 * R, h);
      ctx.restore();
    });
  },

  // Solid ink letters half-dipped in a cyan zigzag wave — the game's wave, the title going
  // under. Painted directly (no destination-in): both fills are text, so ink shows above the
  // waterline and cyan below it, all within the letters.
  waterline: (ctx, W, H, px) => {
    ctx.fillStyle = C.ink;
    ctx.fillText(WORD, W / 2, H / 2);
    ctx.save();
    const baseY = H * 0.6;
    const amp = px * 0.05;
    const seg = 12;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (let i = 0; i <= seg; i++) {
      ctx.lineTo((W * i) / seg, baseY + (i % 2 ? -amp : amp));
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = C.cyan;
    ctx.fillText(WORD, W / 2, H / 2);
    ctx.restore();
  },

  // Yellow face with an ink keyline ring, extruded straight down-right in ink.
  blocky3d: (ctx, W, H, px) => {
    const step = px * 0.021;
    ctx.fillStyle = C.ink;
    for (let o = 6; o >= 1; o--) ctx.fillText(WORD, W / 2 + o * step, H / 2 + o * step);
    ctx.fillStyle = C.yellow;
    ctx.fillText(WORD, W / 2, H / 2);
    // Ring slots behind the face; where it overlaps the extrusion both are ink — invisible.
    paintOutlineRing(ctx, px * 0.02, C.ink, wordPainter(W, H));
  },

  // Open letters: board shows through, ink outline ring only.
  hollow: (ctx, W, H, px) => {
    paintOutlineRing(ctx, px * 0.05, C.ink, wordPainter(W, H));
  },

  // Each letter its own palette colour, each with an ink keyline ring.
  rainbow: (ctx, W, H, px) => {
    const colors = [C.pink, C.cyan, C.yellow, C.green, C.purple, C.red, C.navy, C.pink];
    const spots = glyphSpots(ctx, W, H);
    spots.forEach((sp, i) => {
      ctx.fillStyle = colors[i % colors.length]!;
      paintGlyph(ctx, sp, 'fill');
    });
    paintOutlineRing(ctx, px * 0.025, C.ink, (c, mode) =>
      spots.forEach((sp) => paintGlyph(c, sp, mode))
    );
  },

  // Sticker letters knocked a few degrees off true, Memphis-style. Each glyph paints its
  // own white ring then its ink fill IN ORDER, so a later sticker's white edge laps over
  // its neighbour — the overlapped-stickers look the Text version had.
  wonky: (ctx, W, H, px) => {
    const spots = glyphSpots(ctx, W, H, (i) =>
      i % 2 === 0
        ? { rot: Phaser.Math.DegToRad(-7), dy: px * 0.03 }
        : { rot: Phaser.Math.DegToRad(6), dy: -px * 0.03 }
    );
    for (const sp of spots) {
      paintOutlineRing(ctx, px * 0.04, C.white, (c, mode) => paintGlyph(c, sp, mode), 'over');
      ctx.fillStyle = C.ink;
      paintGlyph(ctx, sp, 'fill');
    }
  },

  // These three never reach BAKE_DRAW (handled as TEXT styles), but the Record needs them.
  longshadow: () => {},
  highlighter: () => {},
  cutout: () => {},
};
