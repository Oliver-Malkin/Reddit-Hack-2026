import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import type { LinkType } from './types';
import type { WordTile } from './WordTile';

const SHAPE_COUNT = 8;
/** Chains wobble fully at/below this length and settle as they stretch taut. */
const SLACK_REF = 250;
/** Gap between a tile's border and the chain's attachment point. */
const TILE_GAP = 14;

// ----- routing -----
// Routes are picked from a small fixed menu rather than solved: the straight shot
// between the facing edges, or a loop out past one of the four sides (side of A →
// same side of B). Every option is scored — does it cross another word? would the
// label chip land on a word? does it leave the canvas or ride a sibling chain? —
// and the cheapest wins. Hysteresis keeps the current pick until a challenger is
// clearly better, and the drawn rope glides toward the picked route with a
// first-order lag, so a switch reads as the chain swinging round, not popping.
/** Points the drawn rope is resampled to (including both endpoints). */
const NODES = 12;
/** Scoring samples along a candidate route. */
const SAMPLES = 20;
/** A route wants this much clear air between itself and every unrelated word. */
const CLEARANCE = 26;
/** How far past the tiles a side loop bulges — a near and a far variant, so two
 *  chains looping out the same side sit on separate rails. */
const LOOP_REACH = [44, 92];
/** Time-constant (ms) for the drawn rope chasing the picked route. */
const FOLLOW_MS = 110;
/** How often (ms) the route is re-scored. Picking a route means building + sampling ~9
 *  candidate splines — far too costly to redo every frame on a phone. The drawn rope still
 *  glides toward the last pick EVERY frame (see FOLLOW_MS), so at this cadence the re-pick is
 *  invisible: motion stays smooth, only the (cheap) route decision is throttled. */
const SOLVE_INTERVAL_MS = 66;
/** A challenger must cost less than this fraction of the current route's cost to
 *  displace it — hysteresis so picks commit instead of flip-flopping. */
const SWITCH_FACTOR = 0.7;
/** Below this length the rope can't read as a chain of shapes at all. */
const MIN_ROPE = 90;
/** Breathing room around the label chip when testing whether it fits. */
const CHIP_PAD = 6;
/** Label chip height (its width varies with the text — see chipHalfW). */
const CHIP_H = 26;
/** How far inside the canvas a loop rail must stay. The rope is only the centerline —
 *  the shapes riding it are ~26px wide and wobble up to ~7px sideways, so they need
 *  this much slack before they visually clip the edge. */
const EDGE_MARGIN = 34;

type Side = 'right' | 'left' | 'bottom' | 'top';
/** A tile's axis-aligned half-extents, inflated by TILE_GAP. */
type Box = { cx: number; cy: number; hx: number; hy: number };
type Candidate = { key: string; pts: Phaser.Math.Vector2[] };

/** Human-facing chip text — often clearer than the raw type name. */
const CHIP_LABEL: Record<LinkType, string> = {
  synonym: 'SYNONYM',
  antonym: 'ANTONYM',
  // The ▸ matches the other directional labels: it flags that the link HAS a direction,
  // not which way it points (the tiles are draggable, so the chevron shapes carry the
  // actual heading). Without it, "IS A" was the only directional type reading as neutral.
  hypernym: 'IS A ▸',
  anagram: 'ANAGRAM',
  meronym: 'PART OF ▸',
  lettersubset: 'LETTERS IN ▸',
  sequence: 'BECOMES ▸',
  rhyme: 'RHYMES',
};

/** Types whose shapes carry a direction and so lock to the chain heading (apex → `to`). */
const DIRECTIONAL = new Set<LinkType>([
  'hypernym',
  'sequence',
  'rhyme',
  'lettersubset',
  'meronym', // part → whole; the glyph noses toward the containing word
]);
/** Types drawn upright so a legible glyph (= / ≠) always reads. */
const UPRIGHT = new Set<LinkType>(['synonym', 'antonym']);

/**
 * A stretchy chain of shapes linking two word tiles. The shape COUNT is constant —
 * dragging tiles apart only widens the spacing. Shapes wobble perpendicular to the
 * chain (less when taut). Motion + form per type carry the relation's meaning:
 *
 * - synonym      "=" coins (white)          — equality; upright.
 * - antonym      "≠" coins (ink, inverse of synonym) — opposition; upright.
 * - hypernym     chevrons (yellow)          — category-of; apex → the narrower word.
 * - anagram      "⟳" mix coins (cyan)       — letters stirred; the glyph itself spins.
 * - meronym      nested squares (purple)    — a part inside a whole; slow turn.
 * - lettersubset arrow-into-bracket (navy)  — letters fly INTO the containing word.
 * - sequence     arrowheads (green)         — grows/precedes; shapes SWELL toward `to`.
 * - rhyme        sound-wave arcs (pink)     — sounds alike; arcs radiate along the chain.
 */
export class Chain {
  private scene: Phaser.Scene;
  readonly type: LinkType;
  private tileA: WordTile;
  private tileB: WordTile;

  private shapes: Phaser.GameObjects.Image[] = [];
  private baseScales: number[] = [];
  private chip: Phaser.GameObjects.Container;
  private phases: number[] = [];
  private wobbleSpeeds: number[] = [];
  private amps: number[] = [];
  private spinSpeeds: number[] = [];
  /** Every word tile in play — candidate routes are scored against all of them. */
  private tiles: WordTile[];
  /** The other chains in play — routes and label chips keep out of each other's way. */
  private peers: Chain[] = [];
  /** Stable side (+1/-1) the direct route's cosmetic bow leans toward. */
  private seedSide: number;
  /** Sticky key of the currently-picked route option. */
  private routeKey = '';
  /** The drawn rope — chases the picked route with a first-order lag (no overshoot). */
  private display: Phaser.Math.Vector2[] = [];
  private lastTime = 0;
  private chipHalfW = 40;
  /** Where along the curve the chip sits (0–1) — glides toward the clearest spot. */
  private chipU = 0.5;
  /** Uniform scale for the chip + shapes, driven by the layout so a cramped phone canvas gets
   *  proportionally smaller links + labels (mirrors how WordTile shrinks). Clamped so labels
   *  never fall below legibility. */
  private layoutScale = 1;
  /** Throttle bookkeeping for the route re-pick (see SOLVE_INTERVAL_MS). */
  private solveAccum = SOLVE_INTERVAL_MS;
  private cachedTarget: Phaser.Math.Vector2[] | null = null;

  /** Direction is A → B: for the directional types A is the "from" end. `tiles` are all
   *  word tiles in play — candidate routes are penalized for crossing any of them. */
  constructor(
    scene: Phaser.Scene,
    type: LinkType,
    tileA: WordTile,
    tileB: WordTile,
    tiles: WordTile[] = []
  ) {
    this.scene = scene;
    this.type = type;
    this.tileA = tileA;
    this.tileB = tileB;
    this.tiles = tiles;
    this.seedSide = Math.random() < 0.5 ? -1 : 1;

    const textures = this.texturesForType();
    for (let i = 0; i < SHAPE_COUNT; i++) {
      // Sequence swells from small (start) to large (end) to show growth over time;
      // everything else is uniform with a little jitter.
      const scale =
        type === 'sequence'
          ? Phaser.Math.Linear(0.34, 0.74, i / (SHAPE_COUNT - 1))
          : 0.5 * Phaser.Math.FloatBetween(0.85, 1.12); // textures baked at 2x
      const img = scene.add.image(0, 0, textures[i % textures.length]!).setScale(scale).setDepth(2);
      this.shapes.push(img);
      this.baseScales.push(scale);
      this.phases.push(Phaser.Math.FloatBetween(0, Math.PI * 2));
      this.wobbleSpeeds.push(Phaser.Math.FloatBetween(1.4, 2.4));
      this.amps.push(Phaser.Math.FloatBetween(3.5, 7));
      this.spinSpeeds.push(Phaser.Math.FloatBetween(0.25, 0.7) * (Math.random() < 0.5 ? -1 : 1));
    }
    this.chip = this.buildChip();
  }

  /** Wire up the other chains so their ropes can push each other apart. */
  setPeers(chains: Chain[]) {
    this.peers = chains.filter((c) => c !== this);
  }

  /** Scale the label chip + shapes with the layout. `s` is the scene's tile scale; it's
   *  clamped here so the label text stays readable even on the smallest canvases. */
  setLayoutScale(s: number) {
    const clamped = Phaser.Math.Clamp(s, 0.72, 1.1);
    if (Math.abs(clamped - this.layoutScale) < 0.001) return;
    this.layoutScale = clamped;
    this.chip.setScale(clamped);
    for (let i = 0; i < this.shapes.length; i++) {
      this.shapes[i]!.setScale(this.baseScales[i]! * clamped);
    }
  }

  /** The chip's on-screen half-width / height, factoring in the layout scale — used for the
   *  routing "does the label fit" test and the on-canvas clamp. */
  private chipHalf(): number {
    return this.chipHalfW * this.layoutScale;
  }
  private chipHeight(): number {
    return CHIP_H * this.layoutScale;
  }

  /** Tear down every GameObject this chain owns — used when a scene reloads its puzzle. */
  destroy() {
    for (const s of this.shapes) s.destroy();
    this.chip.destroy(); // container destroys its graphics + label too
    this.shapes = [];
    this.peers = [];
  }

  /** Where this chain's label chip currently sits — peers keep their chips away. */
  chipPosition(): { x: number; y: number; visible: boolean } {
    return { x: this.chip.x, y: this.chip.y, visible: this.chip.alpha > 0.25 };
  }

  /** The label chip's centre + size, for the tutorial to spotlight it exactly. Null while
   *  the chip is faded (tiles too close for the chain to show a label). */
  chipBounds(): { x: number; y: number; w: number; h: number } | null {
    if (this.chip.alpha <= 0.25) return null;
    return { x: this.chip.x, y: this.chip.y, w: this.chipHalf() * 2, h: this.chipHeight() };
  }

  /** A tile's bounds inflated by TILE_GAP — the box chains attach to. */
  private static box(tile: WordTile): Box {
    return {
      cx: tile.x,
      cy: tile.y,
      hx: (tile.boxWidth / 2) * Math.abs(tile.scaleX) + TILE_GAP,
      hy: (tile.boxHeight / 2) * Math.abs(tile.scaleY) + TILE_GAP,
    };
  }

  /** Signed clearance from a point to a tile's border: positive outside, negative
   *  (depth) inside. */
  private static tileClearance(px: number, py: number, tile: WordTile): number {
    const hx = (tile.boxWidth / 2) * Math.abs(tile.scaleX);
    const hy = (tile.boxHeight / 2) * Math.abs(tile.scaleY);
    const dx = Math.abs(px - tile.x) - hx;
    const dy = Math.abs(py - tile.y) - hy;
    if (dx > 0 || dy > 0) return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return Math.max(dx, dy); // negative: depth inside
  }

  /** Exit distance along `dir` for a point inside an axis-aligned box (relative
   *  coordinates, half-extents hx/hy). */
  private static rayExit(
    relX: number,
    relY: number,
    dirX: number,
    dirY: number,
    hx: number,
    hy: number
  ): number {
    const tx =
      dirX > 1e-6
        ? (hx - relX) / dirX
        : dirX < -1e-6
          ? (-hx - relX) / dirX
          : Number.POSITIVE_INFINITY;
    const ty =
      dirY > 1e-6
        ? (hy - relY) / dirY
        : dirY < -1e-6
          ? (-hy - relY) / dirY
          : Number.POSITIVE_INFINITY;
    return Math.min(tx, ty);
  }

  /** The fixed menu of route options: one direct shot between the facing edges, plus
   *  a loop out past each of the four sides at a near and a far reach. */
  private candidates(): Candidate[] {
    const a = Chain.box(this.tileA);
    const b = Chain.box(this.tileB);
    const out: Candidate[] = [];

    // Direct: straight between the facing edges, with a slight cosmetic bow.
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const eA = Chain.rayExit(0, 0, ux, uy, a.hx, a.hy);
    const eB = Chain.rayExit(0, 0, -ux, -uy, b.hx, b.hy);
    const pA = new Phaser.Math.Vector2(a.cx + ux * eA, a.cy + uy * eA);
    const pB = new Phaser.Math.Vector2(b.cx - ux * eB, b.cy - uy * eB);
    const bow = Math.min(len * 0.08, 16) * this.seedSide;
    const mid = new Phaser.Math.Vector2(
      (pA.x + pB.x) / 2 - uy * bow,
      (pA.y + pB.y) / 2 + ux * bow
    );
    out.push({ key: 'direct', pts: [pA, mid, pB] });

    for (const side of ['right', 'left', 'bottom', 'top'] as const) {
      for (let reach = 0; reach < LOOP_REACH.length; reach++) {
        out.push(this.loopCandidate(side, reach, a, b));
      }
    }
    return out;
  }

  /** Side loop: leave the middle of A's `side` face, run along a rail placed just
   *  past the outermost edge of every tile the loop spans, and come back into the
   *  same face of B. The rail position adapts to the layout, so a loop always has a
   *  clear run wherever one exists on that side. */
  private loopCandidate(side: Side, reach: number, a: Box, b: Box): Candidate {
    const v = (x: number, y: number) => new Phaser.Math.Vector2(x, y);
    const horiz = side === 'right' || side === 'left'; // rail runs vertically
    const sign = side === 'right' || side === 'bottom' ? 1 : -1;

    const aA = horiz ? v(a.cx + sign * a.hx, a.cy) : v(a.cx, a.cy + sign * a.hy);
    const aB = horiz ? v(b.cx + sign * b.hx, b.cy) : v(b.cx, b.cy + sign * b.hy);

    // The rail sits past every tile whose span (along the rail's axis) overlaps the
    // stretch between the two anchors — those are the tiles the loop runs alongside.
    const s0 = horiz ? aA.y : aA.x;
    const s1 = horiz ? aB.y : aB.x;
    const lo = Math.min(s0, s1) - 20;
    const hi = Math.max(s0, s1) + 20;
    const edgeOf = (tb: Box) => (horiz ? tb.cx + sign * tb.hx : tb.cy + sign * tb.hy);
    let rail = sign > 0 ? Math.max(edgeOf(a), edgeOf(b)) : Math.min(edgeOf(a), edgeOf(b));
    for (const t of this.tiles) {
      const tb = Chain.box(t);
      const tLo = horiz ? tb.cy - tb.hy : tb.cx - tb.hx;
      const tHi = horiz ? tb.cy + tb.hy : tb.cx + tb.hx;
      if (tHi < lo || tLo > hi) continue;
      rail = sign > 0 ? Math.max(rail, edgeOf(tb)) : Math.min(rail, edgeOf(tb));
    }
    rail += sign * LOOP_REACH[reach]!;

    // Never build a rail off the canvas. A squeezed loop that hugs the edge scores
    // honestly against the words it now crowds — and loses to a clearer side — where
    // an off-canvas rail would just vanish off-screen and win anyway.
    const railMax = (horiz ? this.scene.scale.width : this.scene.scale.height) - EDGE_MARGIN;
    rail = Phaser.Math.Clamp(rail, EDGE_MARGIN, railMax);
    const bulge = Phaser.Math.Clamp(rail + sign * 12, EDGE_MARGIN, railMax);

    // Two rail points give the loop its flat back; when the anchors are nearly level
    // those would coincide, so bulge a single midpoint instead for a clean arc.
    const mids =
      Math.abs(s0 - s1) < 30
        ? [horiz ? v(bulge, (s0 + s1) / 2) : v((s0 + s1) / 2, bulge)]
        : [horiz ? v(rail, s0) : v(s0, rail), horiz ? v(rail, s1) : v(s1, rail)];
    return { key: `${side}-${reach}`, pts: [aA, ...mids, aB] };
  }

  /** Cost of a candidate: its length, plus heavy penalties for crossing a word,
   *  leaving the canvas, riding a sibling chain, or leaving the label chip with
   *  nowhere to sit. */
  private scoreCandidate(c: Candidate): number {
    const spline = new Phaser.Curves.Spline(c.pts);
    const length = spline.getLength();
    let cost = length;

    if (length < MIN_ROPE) cost += (MIN_ROPE - length) * 10;

    // The chip sits near the middle of the route. What "room for the label" really
    // means is that the chip rectangle doesn't land on a word — NOT that the rope is
    // long: a top-to-bottom link with a modest gap is fine (the chip pokes out
    // sideways over empty space), while two touching tiles are not. Minkowski test:
    // inflate each tile by the chip's half-size and check the midpoint against it.
    const midPt = spline.getPointAt(0.5);
    const chipHalfW = this.chipHalf();
    const chipHalfH = this.chipHeight() / 2;
    for (const tile of this.tiles) {
      const hx = (tile.boxWidth / 2) * Math.abs(tile.scaleX) + chipHalfW + CHIP_PAD;
      const hy = (tile.boxHeight / 2) * Math.abs(tile.scaleY) + chipHalfH + CHIP_PAD;
      const ox = hx - Math.abs(midPt.x - tile.x);
      const oy = hy - Math.abs(midPt.y - tile.y);
      if (ox > 0 && oy > 0) cost += Math.min(ox, oy) * 6;
    }

    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    for (let s = 0; s < SAMPLES; s++) {
      const u = s / (SAMPLES - 1);
      const p = spline.getPointAt(u);
      if (p.x < 8 || p.x > W - 8 || p.y < 8 || p.y > H - 8) cost += 40;

      for (const tile of this.tiles) {
        // The route's own tiles: hugging them near the attachment is fine (that's
        // where the rope leaves), but the middle of the route must not re-cross them.
        // Other words additionally demand CLEARANCE of open air.
        const own = tile === this.tileA || tile === this.tileB;
        if (own && (u < 0.15 || u > 0.85)) continue;
        const pen = (own ? 0 : CLEARANCE) - Chain.tileClearance(p.x, p.y, tile);
        if (pen > 0) cost += pen * 8;
      }
      for (const peer of this.peers) {
        let d = Number.POSITIVE_INFINITY;
        for (const q of peer.display) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
        if (d < 30) cost += (30 - d) * 2;
      }
    }
    return cost;
  }

  /** Pick this frame's route (sticky, so picks don't flicker while dragging) and
   *  resample it to the drawn rope's fixed node count. */
  private solveTarget(): Phaser.Math.Vector2[] {
    let best: Candidate | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    let current: Candidate | null = null;
    let currentCost = Number.POSITIVE_INFINITY;
    for (const c of this.candidates()) {
      const cost = this.scoreCandidate(c);
      if (cost < bestCost) {
        best = c;
        bestCost = cost;
      }
      if (c.key === this.routeKey) {
        current = c;
        currentCost = cost;
      }
    }
    // Hysteresis: keep the current pick unless the challenger is clearly cheaper.
    if (current && best !== current && bestCost > currentCost * SWITCH_FACTOR) {
      best = current;
    }
    this.routeKey = best!.key;

    const spline = new Phaser.Curves.Spline(best!.pts);
    const pts: Phaser.Math.Vector2[] = [];
    for (let i = 0; i < NODES; i++) pts.push(spline.getPointAt(i / (NODES - 1)));
    return pts;
  }

  private texturesForType(): string[] {
    switch (this.type) {
      case 'synonym':
        return ['chain-eq'];
      case 'antonym':
        return ['chain-neq'];
      case 'hypernym':
        return ['chain-chevron-ink', 'chain-chevron-yellow'];
      case 'anagram':
        return ['chain-mix'];
      case 'meronym':
        return ['chain-meronym'];
      case 'lettersubset':
        return ['chain-into'];
      case 'sequence':
        return ['chain-seq'];
      case 'rhyme':
        return ['chain-rhyme'];
    }
  }

  private buildChip(): Phaser.GameObjects.Container {
    const label = this.scene.add.text(0, 0, CHIP_LABEL[this.type], {
      fontFamily: UI_FONT,
      fontSize: '12px',
      fontStyle: '800',
      color: '#1c1c1c',
    });
    label.setOrigin(0.5);

    const w = label.width + 24;
    const h = CHIP_H;
    this.chipHalfW = w / 2;
    const g = this.scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.16); // offset shadow
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, h / 2);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);

    return this.scene.add.container(0, 0, [g, label]).setDepth(4);
  }

  update(time: number) {
    const dtMs = this.lastTime > 0 ? Math.min(time - this.lastTime, 90) : 16.7;
    this.lastTime = time;

    // Re-pick the route only every SOLVE_INTERVAL_MS — the expensive part. The drawn rope
    // still eases toward the last pick every frame below, so motion stays smooth.
    this.solveAccum += dtMs;
    if (!this.cachedTarget || this.solveAccum >= SOLVE_INTERVAL_MS) {
      this.solveAccum = 0;
      this.cachedTarget = this.solveTarget();
    }
    const target = this.cachedTarget;

    if (this.display.length === 0) {
      this.display = target.map((p) => p.clone());
    }
    // The drawn rope glides after the picked route — a pure first-order lag, so a
    // route switch reads as the chain swinging round rather than popping.
    const k = 1 - Math.exp(-dtMs / FOLLOW_MS);
    for (let i = 0; i < NODES; i++) {
      const d = this.display[i]!;
      const g = target[i]!;
      d.x += (g.x - d.x) * k;
      d.y += (g.y - d.y) * k;
    }

    const curve = new Phaser.Curves.Spline(this.display);

    // Wobble amplitude fades as the chain is stretched taut. Fades use the ARC length,
    // not the straight distance, so a bowed chain between close tiles still shows fully.
    const arc = curve.getLength();
    const slack = Phaser.Math.Clamp(SLACK_REF / arc, 0.2, 1);
    const t = time * 0.001;

    for (let i = 0; i < SHAPE_COUNT; i++) {
      const img = this.shapes[i]!;
      const phase = this.phases[i]!;
      const wobbleSpeed = this.wobbleSpeeds[i]!;

      // getPointAt/getTangentAt are arc-length parameterized, so the shapes stay
      // evenly spaced however deeply the curve bows.
      const u = (i + 0.5) / SHAPE_COUNT;
      const pos = curve.getPointAt(u);
      const tan = curve.getTangentAt(u);
      const wobble = Math.sin(t * wobbleSpeed + phase) * this.amps[i]! * slack;
      img.setPosition(pos.x - tan.y * wobble, pos.y + tan.x * wobble);

      const shimmy = Math.sin(t * wobbleSpeed + phase);
      if (DIRECTIONAL.has(this.type)) {
        // Glyph follows the local curve direction (A toward B), riding the sag.
        img.rotation = Math.atan2(tan.y, tan.x) + shimmy * 0.12;
      } else if (UPRIGHT.has(this.type)) {
        img.rotation = shimmy * 0.14; // stays readable, just a gentle rock
      } else {
        img.rotation = t * this.spinSpeeds[i]! + phase; // antonym, anagram: free spin
      }
    }

    // When tiles are pushed together the chain has nowhere to live — fade the shapes
    // and chip out instead of letting them pile up under the tiles.
    const shapeAlpha = Phaser.Math.Clamp((arc - 24) / 60, 0, 1);
    for (const img of this.shapes) img.setAlpha(shapeAlpha);

    // Routes already avoid words, so the chip just prefers the middle of the curve —
    // it only slides aside when a sibling chain's label would stack on top of it.
    let bestU = 0.5;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let s = 0; s <= 6; s++) {
      const u = 0.3 + (0.4 * s) / 6;
      const p = curve.getPointAt(u);
      let chipCrowding = 0;
      for (const peer of this.peers) {
        const pc = peer.chipPosition();
        if (!pc.visible) continue;
        const d = Math.hypot(p.x - pc.x, p.y - pc.y);
        chipCrowding = Math.max(chipCrowding, Math.max(0, 78 - d));
      }
      const score = -chipCrowding * 1.6 - Math.abs(u - 0.5) * 60;
      if (score > bestScore) {
        bestScore = score;
        bestU = u;
      }
    }
    this.chipU += (bestU - this.chipU) * (1 - Math.exp(-dtMs / 250));
    const chipPos = curve.getPointAt(this.chipU);
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const chipHalfW = this.chipHalf();
    const chipEdgeY = this.chipHeight() / 2 + 4;
    this.chip.setPosition(
      Phaser.Math.Clamp(chipPos.x, chipHalfW + 4, W - chipHalfW - 4),
      Phaser.Math.Clamp(chipPos.y, chipEdgeY, H - chipEdgeY)
    );
    this.chip.rotation = Math.sin(t * 0.9) * 0.035;
    // Chips reach full opacity sooner than before (phone layouts pack tiles close, so
    // the old ramp left most labels permanently half-faded).
    this.chip.setAlpha(Phaser.Math.Clamp((arc - 50) / 55, 0, 1));
  }

  /** Bake the chain shape textures once per scene (2x resolution, displayed at ~0.5). */
  static bakeTextures(scene: Phaser.Scene) {
    if (scene.textures.exists('chain-eq')) return;

    const ink = '#1c1c1c';
    const TAU = Math.PI * 2;
    const bake = (key: string, size: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
      const tex = scene.textures.createCanvas(key, size * 2, size * 2)!;
      const ctx = tex.context;
      ctx.clearRect(0, 0, size * 2, size * 2);
      ctx.save();
      ctx.scale(2, 2);
      ctx.translate(size / 2, size / 2);
      draw(ctx);
      ctx.restore();
      tex.refresh();
    };

    // Synonym — white coin stamped with an ink "=": equal, orderly.
    bake('chain-eq', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillStyle = ink;
      const bar = (y: number) => {
        ctx.beginPath();
        ctx.roundRect(-5.5, y, 11, 2.6, 1.3);
        ctx.fill();
      };
      bar(-3.6);
      bar(1.0);
    });

    // Antonym — the synonym coin colour-inverted: ink coin, white "≠".
    bake('chain-neq', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      const bar = (y: number) => {
        ctx.beginPath();
        ctx.roundRect(-5.5, y, 11, 2.6, 1.3);
        ctx.fill();
      };
      bar(-3.6);
      bar(1.0);
      // the strike-through that turns = into ≠
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-3.6, 6.8);
      ctx.lineTo(3.6, -6.8);
      ctx.stroke();
    });

    // Hypernym — "<"/">" (apex → the hyponym, mouth open toward the hypernym it's read as
    // containing — the inequality-symbol mnemonic). Opened wider than a typical arrowhead
    // chevron so a row of these reads as repeated size comparisons rather than a stream of
    // forward-arrows. Yellow variant outlined.
    const chevron = (color: string | null) => (ctx: CanvasRenderingContext2D) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-4.5, -9.5);
        ctx.lineTo(6, 0);
        ctx.lineTo(-4.5, 9.5);
      };
      path();
      ctx.lineWidth = color ? 8 : 5.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      if (color) {
        path();
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    };
    bake('chain-chevron-ink', 26, chevron(null));
    bake('chain-chevron-yellow', 26, chevron('#f5b727'));

    // Anagram — cyan coin with a "⟳" mix glyph: two chasing arcs with arrowheads.
    // The chain spins these freely, so the rotation symbol literally rotates.
    bake('chain-mix', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = '#2ec4d6';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();

      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      const r = 5.2;
      const arrowArc = (a0: number, a1: number) => {
        ctx.beginPath();
        ctx.arc(0, 0, r, a0, a1);
        ctx.stroke();
        // arrowhead at the arc's end, pointing along the direction of travel
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
    });

    // Meronym — a small purple part nosing (via a short arrow) into a larger whole on the
    // leading (+x) side. Heading-locked, so the arrow always points from part toward whole.
    bake('chain-meronym', 26, (ctx) => {
      ctx.lineJoin = 'round';
      // The whole: a larger square outline on the +x (destination) side.
      ctx.beginPath();
      ctx.roundRect(2, -8, 10, 16, 3);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ink;
      ctx.stroke();
      // The part: a small purple block on the -x (source) side.
      ctx.beginPath();
      ctx.roundRect(-12, -4, 8, 8, 2);
      ctx.fillStyle = '#8e44ad';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.stroke();
      // A short arrow carrying the part into the whole — the direction cue.
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
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
    });

    // Letter-subset — an arrow flying INTO a bracket, drawn pointing +x. The chain
    // heading-locks these, so the letters visibly stream toward the containing word.
    bake('chain-into', 26, (ctx) => {
      const navy = '#2b2d6e';
      ctx.strokeStyle = navy;
      ctx.fillStyle = navy;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // the receiving bracket "]"
      ctx.beginPath();
      ctx.moveTo(2.5, -8);
      ctx.lineTo(8, -8);
      ctx.lineTo(8, 8);
      ctx.lineTo(2.5, 8);
      ctx.stroke();
      // arrow entering it
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
    });

    // Sequence — green arrowhead pointing +x (toward the later word). Shapes also swell
    // toward the end (see constructor) to read as growth over time.
    bake('chain-seq', 26, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(-4, -7.5);
      ctx.lineTo(6.5, 0);
      ctx.lineTo(-4, 7.5);
      ctx.closePath();
      ctx.fillStyle = '#27ae60';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.lineJoin = 'round';
      ctx.stroke();
    });

    // Rhyme — concentric pink arcs radiating from a dot: sound waves.
    bake('chain-rhyme', 26, (ctx) => {
      ctx.strokeStyle = '#ff2f8f';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      for (const r of [4, 8, 12]) {
        ctx.beginPath();
        ctx.arc(-7, 0, r, -0.8, 0.8);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff2f8f';
      ctx.beginPath();
      ctx.arc(-7, 0, 1.8, 0, TAU);
      ctx.fill();
    });
  }
}
