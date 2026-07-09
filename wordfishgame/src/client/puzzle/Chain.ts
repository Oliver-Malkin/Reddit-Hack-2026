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
// The path is NOT a physics simulation — springs with inertia oscillated and looked
// erratic. Instead, each frame a target route is SOLVED deterministically: start from
// the straight chord, then alternately smooth it and PROJECT it out of every word's
// clearance zone. The drawn rope then chases that target with a first-order lag, which
// cannot overshoot or oscillate. Same tile layout in ⇒ same route out, every time.
// Projection (unlike repulsion forces) does not cancel out in tight gaps, so a route
// never threads between words it could go around.
/** Route points between the two anchors. */
const INNER_NODES = 9;
/** The route keeps this many px clear of every word it isn't attached to. */
const CLEARANCE = 38;
/** Smooth+project passes per frame — plenty to converge for INNER_NODES points. */
const SOLVER_ITERS = 6;
/** How far a smoothing pass pulls each point toward its neighbours' midpoint. */
const SMOOTHING = 0.45;
/** Time-constant (ms) for the drawn rope chasing the solved route. */
const FOLLOW_MS = 110;
/** A tile's detour side only flips when the other side is this much cheaper —
 *  hysteresis so routes commit to a side instead of flip-flopping. */
const SIDE_SWITCH_FACTOR = 1.6;

// There is deliberately NO separate anchor logic: the route is solved from tile
// CENTRE to tile CENTRE, and the attachment point is simply where that route exits
// the tile's border (borderExit). The path picks its own connection points — a free
// route connects the two words directly across their facing edges, and a detouring
// route's connection slides around the border with it, continuously.

/** Human-facing chip text — often clearer than the raw type name. */
const CHIP_LABEL: Record<LinkType, string> = {
  synonym: 'SYNONYM',
  antonym: 'ANTONYM',
  // Reads specific → general: "ROBIN is a BIRD". The chevrons open toward the broader
  // word (BIRD) and the ◂ points that way too, so the label agrees with the shapes.
  hypernym: '◂ IS A',
  anagram: 'ANAGRAM',
  meronym: 'PART OF ▸',
  lettersubset: 'LETTERS IN ▸',
  sequence: 'BECOMES ▸',
  rhyme: 'RHYMES',
};

/** Types whose shapes carry a direction and so lock to the chain heading (apex → `to`). */
const DIRECTIONAL = new Set<LinkType>(['hypernym', 'sequence', 'rhyme', 'lettersubset']);
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
  /** Every word tile in play — routes are solved to steer clear of all of them. */
  private tiles: WordTile[];
  /** The other chains in play — used to keep the label chips from stacking. */
  private peers: Chain[] = [];
  /** Stable side (+1/-1) this chain prefers to arc toward when the axis is vertical. */
  private seedSide: number;
  /** This frame's solved route (deterministic — recomputed from scratch each frame). */
  private target: { x: number; y: number }[] = [];
  /** The drawn rope — chases the target with a first-order lag (cannot overshoot). */
  private display: { x: number; y: number }[] = [];
  /** Sticky detour side (±1) per blocking tile, so routes commit instead of dithering. */
  private detourSides = new Map<WordTile, number>();
  private lastTime = 0;
  private chipHalfW = 40;
  /** Where along the curve the chip sits (0–1) — glides toward the clearest spot. */
  private chipU = 0.5;

  /** Direction is A → B: for the directional types A is the "from" end. `tiles` are all
   *  word tiles in play — the rope physics repels the line out of every one of them. */
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

  /** Where this chain's label chip currently sits — peers keep their chips away. */
  chipPosition(): { x: number; y: number; visible: boolean } {
    return { x: this.chip.x, y: this.chip.y, visible: this.chip.alpha > 0.25 };
  }

  /** Is the point within the tile's border inflated by TILE_GAP? */
  private static insideInflated(tile: WordTile, px: number, py: number): boolean {
    const hx = (tile.boxWidth / 2) * Math.abs(tile.scaleX) + TILE_GAP;
    const hy = (tile.boxHeight / 2) * Math.abs(tile.scaleY) + TILE_GAP;
    return Math.abs(px - tile.x) < hx && Math.abs(py - tile.y) < hy;
  }

  /** Where a centre-to-centre route leaves its own tile: walk the polyline outward
   *  from the centre (pts[0]) and intersect the first inside→outside segment with the
   *  tile's (gap-inflated) border. This IS the chain's attachment point — it moves
   *  continuously as the route glides, and always faces wherever the line actually
   *  goes. */
  private static borderExit(tile: WordTile, pts: { x: number; y: number }[]): {
    x: number;
    y: number;
  } {
    const hx = (tile.boxWidth / 2) * Math.abs(tile.scaleX) + TILE_GAP;
    const hy = (tile.boxHeight / 2) * Math.abs(tile.scaleY) + TILE_GAP;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      if (Math.abs(p.x - tile.x) < hx && Math.abs(p.y - tile.y) < hy) continue;
      const prev = pts[i - 1]!;
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const t = Chain.rayExit(prev.x - tile.x, prev.y - tile.y, dx / len, dy / len, hx, hy);
      if (t >= 0 && t <= len) return { x: prev.x + (dx / len) * t, y: prev.y + (dy / len) * t };
      return p;
    }
    return pts[pts.length - 1]!; // degenerate: the whole route sits inside the tile
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

  /** Solve this frame's target route between the two anchor points. Start from the
   *  straight chord (plus a small cosmetic arc), then alternately smooth the points
   *  toward their neighbours and PROJECT them out of every other word's clearance
   *  zone. Deterministic and momentum-free — the route cannot bounce or drift. */
  private solveRoute(start: { x: number; y: number }, end: { x: number; y: number }) {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const chordX = end.x - start.x;
    const chordY = end.y - start.y;
    const chordLen = Math.hypot(chordX, chordY) || 1;
    const ux = chordX / chordLen;
    const uy = chordY / chordLen;
    const px = -uy;
    const py = ux;
    const downish = Math.abs(ux) > 0.3 ? Math.sign(ux) : this.seedSide;
    const bow = downish * Math.min(chordLen * 0.1, 22);

    // Fresh start from the chord each frame — the solution depends only on the current
    // layout (plus the sticky sides), never on the previous frame's route.
    for (let i = 0; i < INNER_NODES; i++) {
      const u = (i + 1) / (INNER_NODES + 1);
      const arc = bow * 4 * u * (1 - u);
      const t = this.target[i]!;
      t.x = start.x + chordX * u + px * arc;
      t.y = start.y + chordY * u + py * arc;
    }

    // Words this route must keep clear of, with inflated half-extents.
    const blockers: { tile: WordTile; hx: number; hy: number }[] = [];
    for (const t of this.tiles) {
      if (t === this.tileA || t === this.tileB) continue;
      blockers.push({
        tile: t,
        hx: (t.boxWidth / 2) * Math.abs(t.scaleX) + CLEARANCE,
        hy: (t.boxHeight / 2) * Math.abs(t.scaleY) + CLEARANCE,
      });
    }

    for (let iter = 0; iter < SOLVER_ITERS; iter++) {
      // Smooth toward neighbour midpoints (endpoints are the fixed anchors).
      for (let i = 0; i < INNER_NODES; i++) {
        const t = this.target[i]!;
        const prev = i === 0 ? start : this.target[i - 1]!;
        const next = i === INNER_NODES - 1 ? end : this.target[i + 1]!;
        t.x += ((prev.x + next.x) / 2 - t.x) * SMOOTHING;
        t.y += ((prev.y + next.y) / 2 - t.y) * SMOOTHING;
      }

      // Project points fully out of each blocker's clearance zone, all to that
      // blocker's (sticky) detour side. Ending each iteration on projection means the
      // final route is clear wherever a clear side exists.
      for (const b of blockers) {
        const inside: number[] = [];
        for (let i = 0; i < INNER_NODES; i++) {
          const t = this.target[i]!;
          if (Math.abs(t.x - b.tile.x) < b.hx && Math.abs(t.y - b.tile.y) < b.hy) {
            inside.push(i);
          }
        }
        if (inside.length === 0) {
          if (iter === 0) this.detourSides.delete(b.tile); // not in the way — forget the side
          continue;
        }
        const side = this.pickSide(b, inside, px, py, W, H);
        const dirX = px * side;
        const dirY = py * side;
        for (const i of inside) {
          const t = this.target[i]!;
          const exit = Chain.rayExit(t.x - b.tile.x, t.y - b.tile.y, dirX, dirY, b.hx, b.hy);
          t.x = Phaser.Math.Clamp(t.x + dirX * (exit + 1), 10, W - 10);
          t.y = Phaser.Math.Clamp(t.y + dirY * (exit + 1), 10, H - 10);
        }
      }
    }
  }

  /** Which side of the chord this blocker should be passed on. Cost per side = total
   *  projection distance for the currently-inside points, plus a penalty for exits
   *  that leave the canvas. Sticky with hysteresis: the chosen side only flips when
   *  the other is clearly cheaper, so routes commit instead of dithering. */
  private pickSide(
    b: { tile: WordTile; hx: number; hy: number },
    inside: number[],
    px: number,
    py: number,
    W: number,
    H: number
  ): number {
    const costOf = (side: number) => {
      let c = 0;
      for (const i of inside) {
        const t = this.target[i]!;
        const exit = Chain.rayExit(t.x - b.tile.x, t.y - b.tile.y, px * side, py * side, b.hx, b.hy);
        c += exit;
        const ex = t.x + px * side * exit;
        const ey = t.y + py * side * exit;
        if (ex < 12 || ex > W - 12 || ey < 12 || ey > H - 12) c += 400;
      }
      return c;
    };
    const cPlus = costOf(1);
    const cMinus = costOf(-1);
    const prev = this.detourSides.get(b.tile);
    let side = cPlus <= cMinus ? 1 : -1;
    if (prev !== undefined) {
      const cPrev = prev === 1 ? cPlus : cMinus;
      const cOther = prev === 1 ? cMinus : cPlus;
      side = cOther * SIDE_SWITCH_FACTOR < cPrev ? -prev : prev;
    }
    this.detourSides.set(b.tile, side);
    return side;
  }

  /** Re-choose where this end attaches: sample the whole perimeter, score each spot,
   *  and chase the winner FAST. Scoring, in order of dominance: the departing line
   *  (anchor + first-segment midpoint) must be clear of every other word; the anchor
   *  must face the rope (else the line crosses its own tile); then a small preference
   *  for facing the other tile and a little stickiness so near-ties don't flicker.
   *  Sampling globally is what lets the anchor flip to the opposite side in ~0.1s
   *  instead of crawling around the border. */
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
    const h = 26;
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

    // The route runs CENTRE to CENTRE; the ends inside the tiles get trimmed off at
    // render time (borderExit), which is what defines the attachment points.
    const start = { x: this.tileA.x, y: this.tileA.y };
    const end = { x: this.tileB.x, y: this.tileB.y };

    // First frame: both routes laid straight between the centres.
    if (this.target.length === 0) {
      for (let i = 1; i <= INNER_NODES; i++) {
        const u = i / (INNER_NODES + 1);
        const x = Phaser.Math.Linear(start.x, end.x, u);
        const y = Phaser.Math.Linear(start.y, end.y, u);
        this.target.push({ x, y });
        this.display.push({ x, y });
      }
    }

    this.solveRoute(start, end);

    // The drawn rope glides after the solved route — a pure first-order lag, so it can
    // never overshoot, bounce, or oscillate on its own.
    const k = 1 - Math.exp(-dtMs / FOLLOW_MS);
    for (let i = 0; i < INNER_NODES; i++) {
      const d = this.display[i]!;
      const g = this.target[i]!;
      d.x += (g.x - d.x) * k;
      d.y += (g.y - d.y) * k;
    }

    // Trim the in-tile ends off: the attachment points are wherever the drawn route
    // crosses each tile's border, and only the points outside both tiles are kept.
    const polyline = [start, ...this.display, end];
    const exitA = Chain.borderExit(this.tileA, polyline);
    const exitB = Chain.borderExit(this.tileB, [...polyline].reverse());
    const renderPts = [new Phaser.Math.Vector2(exitA.x, exitA.y)];
    for (const n of this.display) {
      if (Chain.insideInflated(this.tileA, n.x, n.y)) continue;
      if (Chain.insideInflated(this.tileB, n.x, n.y)) continue;
      renderPts.push(new Phaser.Math.Vector2(n.x, n.y));
    }
    renderPts.push(new Phaser.Math.Vector2(exitB.x, exitB.y));
    const curve = new Phaser.Curves.Spline(renderPts);

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
      } else if (this.type === 'meronym') {
        img.rotation = shimmy * 0.5; // slow quarter-turn sway
      } else {
        img.rotation = t * this.spinSpeeds[i]! + phase; // antonym, anagram: free spin
      }
    }

    // When tiles are pushed together the chain has nowhere to live — fade the shapes
    // and chip out instead of letting them pile up under the tiles.
    const shapeAlpha = Phaser.Math.Clamp((arc - 24) / 60, 0, 1);
    for (const img of this.shapes) img.setAlpha(shapeAlpha);

    // The label chip doesn't insist on the apex: when a dodged tile (or another word)
    // crowds the middle of the arc, it slides along the curve toward the clearest spot,
    // so it never ends up hiding underneath a tile. It glides there (smoothed, like the
    // bow) and is clamped on-canvas so an edge-hugging route never clips its label.
    let bestU = 0.5;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let s = 0; s <= 8; s++) {
      const u = 0.25 + (0.5 * s) / 8;
      const p = curve.getPointAt(u);
      let clearance = Number.POSITIVE_INFINITY;
      for (const tile of this.tiles) {
        if (tile === this.tileA || tile === this.tileB) continue;
        clearance = Math.min(clearance, Chain.tileClearance(p.x, p.y, tile));
      }
      // Keep clear of the other chains' chips too — two labels stacked on top of each
      // other are both unreadable.
      let chipCrowding = 0;
      for (const peer of this.peers) {
        const pc = peer.chipPosition();
        if (!pc.visible) continue;
        const d = Math.hypot(p.x - pc.x, p.y - pc.y);
        chipCrowding = Math.max(chipCrowding, Math.max(0, 78 - d));
      }
      // Slight pull toward the middle so the chip only wanders when it has to.
      const score = Math.min(clearance, 120) - Math.abs(u - 0.5) * 60 - chipCrowding * 1.6;
      if (score > bestScore) {
        bestScore = score;
        bestU = u;
      }
    }
    this.chipU += (bestU - this.chipU) * (1 - Math.exp(-dtMs / 250));
    const chipPos = curve.getPointAt(this.chipU);
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.chip.setPosition(
      Phaser.Math.Clamp(chipPos.x, this.chipHalfW + 4, W - this.chipHalfW - 4),
      Phaser.Math.Clamp(chipPos.y, 17, H - 17)
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

    // Hypernym — chevron ">" pointing +x (apex → the hyponym). Yellow variant outlined.
    const chevron = (color: string | null) => (ctx: CanvasRenderingContext2D) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-5.5, -8.5);
        ctx.lineTo(7, 0);
        ctx.lineTo(-5.5, 8.5);
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

    // Meronym — a small purple square nested inside a larger outline: a part within a whole.
    bake('chain-meronym', 26, (ctx) => {
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.roundRect(-10, -10, 20, 20, 4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(-4.5, -4.5, 9, 9, 2);
      ctx.fillStyle = '#8e44ad';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.stroke();
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
