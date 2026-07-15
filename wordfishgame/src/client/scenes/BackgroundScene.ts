import Phaser from 'phaser';
import { PALETTE, cssColor } from '../theme';
import { debugEnabled, perf } from '../debug';

/** When the debug HUD is on, time this scene's per-frame update for the HUD. */
const PERF = debugEnabled();

const FOREGROUND_COLORS = [
  PALETTE.pink,
  PALETTE.cyan,
  PALETTE.yellow,
  PALETTE.navy,
  PALETTE.green,
  PALETTE.purple,
];
// Small marks get accent colors the big shapes don't use — red and ink confetti,
// straight from the classic Memphis playbook.
const SQUIGGLE_COLORS = [PALETTE.pink, PALETTE.cyan, PALETTE.yellow, PALETTE.red, PALETTE.ink];

// --- Floating-shape depth & shadow tuning ---------------------------------------------
// Each shape floats at its own "height" above the page (0 = resting on the grid, 1 =
// nearest the viewer), which drives both stacking and shadow projection.
//
// Bodies fan out across [BODY_DEPTH_BASE, BODY_DEPTH_BASE + DEPTH_SPREAD] by height, so a
// nearer shape renders over the shapes behind it.
//
// Shadows are a real projection with light off the top-left: a caster at height H throws
// its shadow down-right by a distance proportional to the GAP between it and the surface
// catching it. On the page that gap is H; on another (lower) shape at height h it is only
// H − h, so the shadow lands much closer to the caster there — producing a visible step at
// the shape's raised edge. Every shape casts a ground shadow (an ink silhouette beneath
// all bodies), and separately carries the shadows cast onto IT by nearer shapes, clipped
// to its silhouette and drawn just above its own body.
const BODY_DEPTH_BASE = 20;
const DEPTH_SPREAD = 80;
const GROUND_SHADOW_DEPTH = 5; // ground shadows sit here, beneath every body
const RECV_SHADOW_DEPTH_GAP = 0.4; // a shape's cast-upon shadow sits just above its body
const SHADOW_MIN_OFFSET = 4; // contact throw at zero height gap
const SHADOW_GAP_OFFSET = 26; // extra throw per unit of height gap
const SHADOW_ALPHA = 0.16;
const SHADOW_HEIGHT_EPS = 0.02; // ignore casters barely taller than their receiver

// Decor is faded in/out (not popped) whenever it spawns/despawns — on a resize top-up/trim or
// a new spawn. The fade is reversible: shrinking then growing again revives the still-fading
// pieces instead of removing them and making new ones, so a quick wobble "goes back on itself".
const SQUIGGLE_ALPHA = 0.85; // a squiggle's resting opacity
const ECHO_ALPHA = 0.45; // a shape's displaced echo-outline opacity
const FADE_MS = 260; // fairly quick, but visibly gradual

type ShapeType = 'rect' | 'triangle' | 'circle' | 'diamond' | 'pill' | 'semi';
type FillMode = 'solid' | 'outline' | 'patternDots' | 'patternStripes';
type BorderWeight = 'thick' | 'thin' | 'none';
type DetailType = 'none' | 'dots' | 'stripes' | 'twotone';

type ShapeRecipe = {
  type: ShapeType;
  color: number;
  size: number;
  fillMode: FillMode;
  borderWeight: BorderWeight;
  detail: DetailType;
  detailColor: number;
  detailAlpha: number;
  echo: boolean;
};

type Squiggle = {
  obj: Phaser.GameObjects.Image;
  speed: number;
  // Set while the mark is fading out toward removal; excluded from the live count and eligible
  // to be revived (faded back in) if a grow needs a mark again before it finishes fading.
  retiring: boolean;
  fadeTween: Phaser.Tweens.Tween | null;
};

type FloatingShape = {
  container: Phaser.GameObjects.Container;
  // Ground shadow: an ink silhouette on the page, below every body, thrown down-right by
  // the shape's height. Poolindex's baked shadow texture, rendered directly.
  shadow: Phaser.GameObjects.Image;
  // Shadows cast onto THIS shape by nearer shapes — a per-shape canvas clipped to its
  // silhouette, created lazily the first frame something casts onto it.
  recv: Phaser.GameObjects.Image | null;
  recvKey: string | null;
  echo: Phaser.GameObjects.Image | null;
  height: number; // 0 = flat on the page, 1 = nearest the viewer
  speed: number;
  rotSpeed: number;
  poolIndex: number;
  // Fade multiplier (0..1) applied to the whole shape (body + shadow + echo + received
  // shadow) every frame, so a spawn/despawn glides in/out instead of popping. See the
  // Squiggle comment for the retiring/revive lifecycle.
  fade: number;
  retiring: boolean;
  fadeTween: Phaser.Tweens.Tween | null;
};

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

export class BackgroundScene extends Phaser.Scene {
  private grid!: Phaser.GameObjects.TileSprite;
  // Accumulated grid drift, wrapped to one cell. The grid scrolls by moving the whole sprite
  // (and wrapping every GRID_CELL px) rather than by nudging tilePosition — see update() for why
  // that distinction is the single biggest perf lever in this scene on the Canvas renderer.
  private gridScroll = 0;
  private squiggles: Squiggle[] = [];
  private shapes: FloatingShape[] = [];
  private decorHidden = false; // clean mode — see setDecorHidden
  private fieldWidth = 0;
  private fieldHeight = 0;

  private rng!: () => number;
  private shapePool: ShapeRecipe[] = [];
  // Baked body textures, kept by pool index so the shadow bake can read their canvas
  // back without casting the generic Texture the manager hands out.
  private bodyCanvasByRecipe = new Map<number, Phaser.Textures.CanvasTexture>();
  // Baked ink-silhouette canvases per recipe, reused as the source for the shadows a shape
  // casts onto its neighbours.
  private shadowCanvasByRecipe = new Map<number, HTMLCanvasElement>();
  private recvCounter = 0; // unique-key source for the lazily-made received-shadow canvases
  // Cast-on shadows are re-projected on a throttle, not every frame: each receiver that has a
  // caster redraws a canvas and re-uploads it to the GPU, which is the scene's heaviest cost on
  // a phone. The shapes drift slowly (see spawnShapeFromPool speeds), so refreshing every few
  // frames is visually indistinguishable while cutting that cost by RECV_SHADOW_INTERVAL×.
  private recvShadowFrame = 0;
  private readonly RECV_SHADOW_INTERVAL = 3;
  // Shapes respawn this far off every edge. It must comfortably exceed the parallax pan
  // distance (see panParallaxTo) — otherwise, once the camera is offset for a page, the
  // respawn band sits inside the visible area and shapes visibly pop in at the edge.
  private readonly WRAP_MARGIN = 340;
  // Squiggles wrap over a much tighter vertical band than the shapes (the camera only pans on
  // X, so the bottom re-entry is always off-screen). This is that band's half-height — used
  // everywhere squiggles are placed so they populate the full wrap band, not just the visible
  // field (see scatterSquiggles / squiggleTargetCount).
  private readonly SQUIGGLE_Y_MARGIN = 30;
  // The grid tilesprite extends this far past each edge so nothing ever uncovers a bare strip of
  // off-white. It only has to cover the worst-case reveal: the parallax camera pan (≤160px, see
  // parallaxOffset) plus the ≤GRID_CELL the sprite itself shifts as it scroll-wraps (see update).
  // 160 + 60 = 220, so 240 clears it with margin. (Was 520 — pure overkill, and on the Canvas
  // fallback every extra px is CPU blit cost every frame: the grid canvas scales with this².)
  private readonly GRID_OVERSCAN = 240;
  private readonly GRID_CELL = 60; // grid line spacing; the grid is periodic at this size
  private readonly TEXTURE_RES = 2; // supersample baked shape textures for crisp rotated edges
  private readonly TEXTURE_PAD = 10; // bbox padding so the thick border stroke isn't cropped

  private seed: number;

  constructor(seed: number = Date.now() & 0xffffffff) {
    super('BackgroundScene');
    this.seed = seed;
  }

  create() {
    this.fieldWidth = this.scale.width;
    this.fieldHeight = this.scale.height;
    this.rng = mulberry32(this.seed);

    this.buildGrid();
    this.buildSquiggleAtlas();
    this.scatterSquiggles();

    this.shapePool = this.buildShapePool();
    this.spawnFloatingShapes();

    this.scale.on('resize', this.handleResize, this);

    // Menu layer renders on top — launched after the background so scene order is stable.
    // The menu, in turn, launches the puzzle when a difficulty is chosen.
    this.scene.launch('MenuScene');
  }

  /**
   * Glide the whole background sideways to an absolute scroll offset, used by page
   * transitions as a distant parallax layer. A positive target shifts the visible content
   * left (as if the camera panned right); 0 is the resting view. The oversized grid (see
   * GRID_OVERSCAN) keeps the edges filled while the camera is offset, and the drifting
   * shapes wrap in world space so they keep flowing regardless of where the camera sits.
   */
  panParallaxTo(scrollX: number, duration = 640) {
    const cam = this.cameras.main;
    this.tweens.killTweensOf(cam);
    if (duration <= 0) {
      cam.scrollX = scrollX; // snap (page jumps) — a 0ms tween would land a frame late
      return;
    }
    this.tweens.add({
      targets: cam,
      scrollX,
      duration,
      ease: 'Cubic.easeInOut',
    });
  }

  /** The parallax offset a page should pan the background to (less than the UI's full
   *  sweep, so the background reads as a more distant layer). */
  parallaxOffset(): number {
    return Math.min(160, this.scale.width * 0.14);
  }

  private rngBetween(min: number, max: number) {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }
  private rngFloat(min: number, max: number) {
    return this.rng() * (max - min) + min;
  }
  private rngPick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)]!;
  }

  // ---------- GRID ----------

  private buildGrid() {
    const cellSize = this.GRID_CELL;
    const g = this.make.graphics({}, false);
    g.fillStyle(PALETTE.offWhite, 1);
    g.fillRect(0, 0, cellSize, cellSize);
    g.lineStyle(1, PALETTE.gridLine, 1);
    g.strokeRect(0, 0, cellSize, cellSize);
    g.generateTexture('grid-cell', cellSize, cellSize);
    g.destroy();

    // Lineless variant for clean mode — same off-white so the page tone doesn't shift,
    // just no scrolling grid to trigger motion sickness.
    const p = this.make.graphics({}, false);
    p.fillStyle(PALETTE.offWhite, 1);
    p.fillRect(0, 0, cellSize, cellSize);
    p.generateTexture('grid-cell-plain', cellSize, cellSize);
    p.destroy();

    const o = this.GRID_OVERSCAN;
    this.grid = this.add
      .tileSprite(-o, -o, this.fieldWidth + o * 2, this.fieldHeight + o * 2, 'grid-cell')
      .setOrigin(0, 0)
      .setDepth(0);
  }

  // ---------- SQUIGGLES ----------

  /**
   * Bake every motif × colour variant into ONE atlas texture ('sq-atlas'), with a named frame
   * per variant. Previously each was its own generated texture, so the 32 scattered squiggles
   * cost ~32 draw calls (a texture swap per image defeats batching). Sharing one atlas texture
   * lets Phaser batch them all into a single draw. Drawn with canvas 2D (round caps/joins to
   * match the old Graphics strokes); the frame coords index straight into the grid cells.
   */
  private buildSquiggleAtlas() {
    const key = 'sq-atlas';
    if (this.textures.exists(key)) return;
    const CELL = 28; // ≥ the largest motif (26×18) so cells never overlap
    const motifs: {
      name: string;
      w: number;
      h: number;
      draw: (c: CanvasRenderingContext2D, color: number) => void;
    }[] = [
      {
        name: 'zigzag',
        w: 25,
        h: 18,
        draw: (c, col) => this.strokePoly(c, col, 4, [2, 16, 9, 2, 16, 16, 23, 2]),
      },
      {
        name: 'ring',
        w: 16,
        h: 16,
        draw: (c, col) => {
          c.lineWidth = 3;
          c.strokeStyle = cssColor(col);
          c.beginPath();
          c.arc(8, 8, 6, 0, Math.PI * 2);
          c.stroke();
        },
      },
      {
        name: 'dots',
        w: 16,
        h: 16,
        draw: (c, col) => {
          c.fillStyle = cssColor(col);
          for (let row = 0; row < 2; row++) {
            for (let cc = 0; cc < 2; cc++) {
              c.beginPath();
              c.arc(4 + cc * 8, 4 + row * 8, 2.5, 0, Math.PI * 2);
              c.fill();
            }
          }
        },
      },
      {
        name: 'spark',
        w: 14,
        h: 14,
        draw: (c, col) => {
          this.strokePoly(c, col, 2.5, [7, 0, 7, 14]);
          this.strokePoly(c, col, 2.5, [0, 7, 14, 7]);
          this.strokePoly(c, col, 2.5, [2, 2, 12, 12]);
          this.strokePoly(c, col, 2.5, [12, 2, 2, 12]);
        },
      },
      {
        name: 'plus',
        w: 16,
        h: 16,
        draw: (c, col) => {
          this.strokePoly(c, col, 3.5, [8, 1, 8, 15]);
          this.strokePoly(c, col, 3.5, [1, 8, 15, 8]);
        },
      },
      {
        name: 'slash',
        w: 15,
        h: 16,
        draw: (c, col) => this.strokePoly(c, col, 3.5, [3, 14, 12, 2]),
      },
      {
        name: 'dot',
        w: 8,
        h: 8,
        draw: (c, col) => {
          c.fillStyle = cssColor(col);
          c.beginPath();
          c.arc(4, 4, 3.5, 0, Math.PI * 2);
          c.fill();
        },
      },
      {
        name: 'wave',
        w: 26,
        h: 12,
        draw: (c, col) => {
          const pts: number[] = [1, 6];
          for (let x = 1; x <= 24; x++) pts.push(1 + x, 6 + Math.sin((x / 24) * Math.PI * 3) * 4);
          this.strokePoly(c, col, 3, pts);
        },
      },
    ];

    const cols = motifs.length;
    const rows = SQUIGGLE_COLORS.length;
    const tex = this.textures.createCanvas(key, cols * CELL, rows * CELL)!;
    const ctx = tex.context;
    ctx.clearRect(0, 0, cols * CELL, rows * CELL);
    SQUIGGLE_COLORS.forEach((color, r) => {
      motifs.forEach((m, c) => {
        const ox = c * CELL;
        const oy = r * CELL;
        ctx.save();
        ctx.translate(ox, oy);
        m.draw(ctx, color);
        ctx.restore();
        tex.add(`${m.name}-${color}`, 0, ox, oy, m.w, m.h);
      });
    });
    tex.refresh();
  }

  /** Stroke an open polyline [x0,y0,x1,y1,…] with round caps/joins (matches Phaser Graphics). */
  private strokePoly(c: CanvasRenderingContext2D, color: number, width: number, pts: number[]) {
    c.lineWidth = width;
    c.strokeStyle = cssColor(color);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i]!, pts[i + 1]!);
    c.stroke();
  }

  /**
   * How many small marks the current field should hold. Counted over the EXTENDED band (visible
   * field + wrap margins) where the marks actually live, not just the visible field — so the
   * *visible* density stays ~1 mark per 24k px² (matching the old 32 at 1024×768) while the
   * off-screen margins are populated at the same density too. Keeping the margins full is what
   * stops a horizontal resize from dragging a bare, never-populated margin into view as an
   * empty vertical band, and a grown window from thinning out into a void.
   */
  private squiggleTargetCount(): number {
    const extW = this.fieldWidth + this.WRAP_MARGIN * 2;
    const extH = this.fieldHeight + this.SQUIGGLE_Y_MARGIN * 2;
    // ~1 mark per 38k px² of the extended band — an airy speckle. Raise this divisor to thin
    // it further, lower it to make the field busier.
    return Math.max(8, Math.round((extW * extH) / 38_000));
  }

  private scatterSquiggles() {
    const mx = this.WRAP_MARGIN;
    const my = this.SQUIGGLE_Y_MARGIN;
    const extW = this.fieldWidth + mx * 2;
    const extH = this.fieldHeight + my * 2;
    const targetCount = this.squiggleTargetCount();

    // Stratify across the extended band (not just the visible field) so the wrap margins are
    // seeded from frame one — otherwise they only fill in slowly via drift, and a resize that
    // pulls a margin into view exposes it as a bare band.
    const cols = Math.ceil(Math.sqrt((targetCount * extW) / extH));
    const rows = Math.ceil(targetCount / cols);
    const cellW = extW / cols;
    const cellH = extH / rows;

    let placed = 0;
    for (let row = 0; row < rows && placed < targetCount; row++) {
      for (let col = 0; col < cols && placed < targetCount; col++) {
        if (this.rng() < 0.15) continue;

        const x = -mx + col * cellW + this.rngFloat(0.2, 0.8) * cellW;
        const y = -my + row * cellH + this.rngFloat(0.2, 0.8) * cellH;
        this.spawnSquiggle(x, y);
        placed++;
      }
    }
  }

  /** Add one drifting squiggle at (x, y) with a random motif, colour, spin and scale. When
   *  `fadeIn` it eases up from transparent (used for resize top-ups); the initial scatter
   *  passes false so the field is simply there on load. */
  private spawnSquiggle(x: number, y: number, fadeIn = false) {
    const motifs = ['zigzag', 'ring', 'dots', 'spark', 'plus', 'slash', 'dot', 'wave'];
    const motif = this.rngPick(motifs);
    const color = this.rngPick(SQUIGGLE_COLORS);
    const frame = `${motif}-${color}`;

    const img = this.add
      .image(x, y, 'sq-atlas', frame)
      .setRotation(this.rngFloat(0, Math.PI * 2))
      .setScale(this.rngFloat(0.9, 1.3))
      .setAlpha(fadeIn ? 0 : SQUIGGLE_ALPHA)
      .setDepth(1)
      .setVisible(!this.decorHidden);

    const s: Squiggle = { obj: img, speed: this.rngFloat(0.03, 0.038), retiring: false, fadeTween: null };
    this.squiggles.push(s);
    if (fadeIn) this.fadeInSquiggle(s);
  }

  // ---------- DECOR FADE LIFECYCLE ----------

  /** Live (non-retiring) squiggle count — what the density target is measured against. */
  private liveSquiggleCount(): number {
    let n = 0;
    for (const s of this.squiggles) if (!s.retiring) n++;
    return n;
  }

  /** A random squiggle that isn't already fading out, or null if none. */
  private randomLiveSquiggle(): Squiggle | null {
    const live = this.squiggles.filter((s) => !s.retiring);
    return live.length ? live[Math.floor(this.rng() * live.length)]! : null;
  }

  /** Fade a squiggle up to its resting opacity (also cancels an in-flight fade-out — the
   *  "revive" that lets a shrink→grow wobble reverse instead of churning marks). */
  private fadeInSquiggle(s: Squiggle) {
    s.retiring = false;
    s.fadeTween?.stop();
    s.fadeTween = this.tweens.add({
      targets: s.obj,
      alpha: SQUIGGLE_ALPHA,
      duration: FADE_MS,
      ease: 'Sine.easeOut',
    });
  }

  /** Fade a squiggle out, then remove it once transparent. No-op if already retiring. */
  private retireSquiggle(s: Squiggle) {
    if (s.retiring) return;
    s.retiring = true;
    s.fadeTween?.stop();
    s.fadeTween = this.tweens.add({
      targets: s.obj,
      alpha: 0,
      duration: FADE_MS,
      ease: 'Sine.easeIn',
      onComplete: () => {
        if (!s.retiring) return; // revived mid-fade — keep it
        const i = this.squiggles.indexOf(s);
        if (i >= 0) this.squiggles.splice(i, 1);
        s.obj.destroy();
      },
    });
  }

  // ---------- SHAPE RECIPE POOL ----------

  private buildShapePool(): ShapeRecipe[] {
    const shapeTypes: ShapeType[] = ['rect', 'triangle', 'circle', 'diamond', 'pill', 'semi'];

    // One recipe per unique (type, color) combo. Drawing type and color independently
    // at random left ~9 of the 24 combos duplicated on average (birthday problem),
    // which showed up on screen as clusters of near-identical shapes.
    const combos: Array<{ type: ShapeType; color: number }> = [];
    for (const type of shapeTypes) {
      for (const color of FOREGROUND_COLORS) {
        combos.push({ type, color });
      }
    }
    // Fisher–Yates shuffle so the recipe order (and thus spawn order) stays seeded-random.
    for (let i = combos.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = combos[i]!;
      combos[i] = combos[j]!;
      combos[j] = tmp;
    }

    const pool: ShapeRecipe[] = [];
    for (const combo of combos) {
      const fillMode: FillMode = this.rngPick<FillMode>([
        'solid', 'solid', 'solid', 'solid', 'solid', 'solid',
        'outline',
        'patternDots',
        'patternStripes',
      ]);
      const borderWeight: BorderWeight = this.rngPick<BorderWeight>([
        'thick', 'thick', 'thick', 'thick', 'thick', 'thick',
        'thin', 'thin',
        'none',
      ]);
      const detail: DetailType =
        fillMode === 'solid'
          ? this.rngPick<DetailType>(['none', 'none', 'dots', 'stripes', 'twotone'])
          : 'none';
      const detailPairs: [number, number][] = [
        [PALETTE.ink, 0.4],
        [PALETTE.ink, 0.18],
        [PALETTE.navy, 0.35],
        [0xffffff, 0.3],
      ];
      const [detailColor, detailAlpha] = this.rngPick(detailPairs);

      pool.push({
        type: combo.type,
        color: combo.color,
        // Mostly mid-sized, with the occasional oversized statement piece.
        size: this.rng() < 0.2 ? this.rngBetween(150, 210) : this.rngBetween(70, 130),
        fillMode,
        borderWeight,
        detail,
        detailColor,
        detailAlpha,
        // The displaced echo outline is an accent, not a uniform — only a few shapes get it.
        echo: this.rng() < 0.25,
      });
    }
    return pool;
  }

  // ---------- FOREGROUND FLOATING SHAPES ----------

  private spawnFloatingShapes() {
    // Spawn over the EXTENDED field (visible area + wrap margins on every side) so the
    // off-screen entry band is populated from frame one — otherwise the first shapes to
    // drift off the top-left have no replacements in flight and a hole crosses the screen.
    const m = this.WRAP_MARGIN;
    const extW = this.fieldWidth + m * 2;
    const extH = this.fieldHeight + m * 2;

    // Density-based count so coverage is consistent across window sizes.
    // ~1 shape per 290k px² — airier than the original 260k now that some shapes run
    // large, but dense enough that the field never looks empty between wraps.
    const count = Math.max(8, Math.round((extW * extH) / 290_000));

    // Stratified jittered grid (same trick as the squiggles) — even coverage, no clusters.
    const cols = Math.ceil(Math.sqrt((count * extW) / extH));
    const rows = Math.ceil(count / cols);
    const cellW = extW / cols;
    const cellH = extH / rows;

    let spawned = 0;
    for (let row = 0; row < rows && spawned < count; row++) {
      for (let col = 0; col < cols && spawned < count; col++) {
        const x = -m + col * cellW + this.rngFloat(0.15, 0.85) * cellW;
        const y = -m + row * cellH + this.rngFloat(0.15, 0.85) * cellH;
        this.spawnShapeFromPool(spawned % this.shapePool.length, x, y);
        spawned++;
      }
    }
  }

  private spawnShapeFromPool(poolIndex: number, x: number, y: number, fadeIn = false) {
    const idx = poolIndex % this.shapePool.length;
    const recipe = this.shapePool[idx]!;
    // Gentle drift — this sits behind word tiles the player is reading, so the
    // motion should register as ambient, not draw the eye.
    const speed = this.rngFloat(0.04, 0.075);

    // Height above the page (0..1). Larger shapes read as nearer, so they tend to float
    // higher; a little jitter stops same-sized shapes banding at one depth. See the depth
    // tuning block up top for how this feeds the stacking + shadow projection.
    const sizeNorm = Phaser.Math.Clamp((recipe.size - 70) / (210 - 70), 0, 1);
    const height = Phaser.Math.Clamp(0.3 + sizeNorm * 0.5 + this.rngFloat(-0.12, 0.12), 0.12, 1);
    const bodyDepth = BODY_DEPTH_BASE + height * DEPTH_SPREAD;

    // Ground shadow — an ink-flattened stamp of the baked body texture, so it matches what
    // the shape renders (outline shapes cast a ring, patterns cast per-dot). Thrown
    // down-right by the shape's full height, and kept below every body so a nearer shape
    // floating over it hides it (the shadow reappears on that shape via updateReceivedShadows).
    const shadow = this.add
      .image(x, y, this.ensureShadowTexture(idx))
      .setScale(1 / this.TEXTURE_RES)
      .setAlpha(SHADOW_ALPHA)
      .setDepth(GROUND_SHADOW_DEPTH);

    // Displaced echo outline — accent on a few recipes only. Baked from the SAME canvas
    // path as the body (like the shadow), so its silhouette can never drift out of sync
    // with the rendered shape — hand-drawn echo geometry once gave diamonds sharp
    // corners while their bodies were rounded.
    let echo: Phaser.GameObjects.Image | null = null;
    if (recipe.echo) {
      echo = this.add
        .image(x - 7, y - 5, this.ensureEchoTexture(idx))
        .setScale(1 / this.TEXTURE_RES)
        .setAlpha(ECHO_ALPHA)
        .setDepth(bodyDepth - 0.25);
    }

    // Body + border come from a texture baked once per recipe (see ensureShapeTexture) —
    // Phaser 4 geometry masks are Canvas-renderer only, so clipping is done at bake
    // time with ctx.clip() instead: an exact fill∩silhouette intersection.
    const body = this.add
      .image(0, 0, this.ensureShapeTexture(idx))
      .setScale(1 / this.TEXTURE_RES);

    const container = this.add.container(x, y, [body]);
    container.setDepth(bodyDepth);

    const shape: FloatingShape = {
      container,
      shadow,
      recv: null,
      recvKey: null,
      echo,
      height,
      speed,
      rotSpeed: this.rngFloat(-0.0002, 0.0002),
      poolIndex: idx,
      fade: fadeIn ? 0 : 1,
      retiring: false,
      fadeTween: null,
    };
    this.shapes.push(shape);
    this.applyShapeFade(shape); // stamp the initial opacity (0 when fading in)
    if (fadeIn) this.fadeInShape(shape);
  }

  // ---------- SHAPE FADE LIFECYCLE (mirrors the squiggle one) ----------

  /** Push a shape's fade multiplier onto all of its parts. Called every frame from update()
   *  (the fade tween drives shape.fade; this reflects it), and once at spawn. */
  private applyShapeFade(shape: FloatingShape) {
    const a = shape.fade;
    shape.container.setAlpha(a);
    shape.shadow.setAlpha(SHADOW_ALPHA * a);
    shape.echo?.setAlpha(ECHO_ALPHA * a);
    shape.recv?.setAlpha(SHADOW_ALPHA * a);
  }

  private liveShapeCount(): number {
    let n = 0;
    for (const s of this.shapes) if (!s.retiring) n++;
    return n;
  }

  private randomLiveShape(): FloatingShape | null {
    const live = this.shapes.filter((s) => !s.retiring);
    return live.length ? live[Math.floor(this.rng() * live.length)]! : null;
  }

  /** Fade a shape up to full (and cancel any in-flight fade-out — the revive). */
  private fadeInShape(shape: FloatingShape) {
    shape.retiring = false;
    shape.fadeTween?.stop();
    shape.fadeTween = this.tweens.add({
      targets: shape,
      fade: 1,
      duration: FADE_MS,
      ease: 'Sine.easeOut',
    });
  }

  /** Fade a shape out, then tear it down once invisible. No-op if already retiring. */
  private retireShape(shape: FloatingShape) {
    if (shape.retiring) return;
    shape.retiring = true;
    shape.fadeTween?.stop();
    shape.fadeTween = this.tweens.add({
      targets: shape,
      fade: 0,
      duration: FADE_MS,
      ease: 'Sine.easeIn',
      onComplete: () => {
        if (!shape.retiring) return; // revived mid-fade
        const i = this.shapes.indexOf(shape);
        if (i >= 0) this.shapes.splice(i, 1);
        shape.container.destroy(true);
        shape.shadow.destroy();
        shape.echo?.destroy();
        this.disposeRecvShadow(shape);
      },
    });
  }

  /** Destroys a shape and rebuilds it from the NEXT pool recipe at a torus-wrapped position. */
  private respawnShape(shape: FloatingShape) {
    // Torus wrap: translate by the extended-field period on whichever axis left it.
    // Wrapped coordinates land just beyond the bottom/right edge (matching the up-left
    // pan), and — unlike random re-entry — wrapping is measure-preserving, so the
    // stratified initial spread stays evenly distributed forever instead of decaying
    // into clusters and long empty stretches.
    const m = this.WRAP_MARGIN;
    let x = shape.container.x;
    let y = shape.container.y;
    if (x < -m) x += this.fieldWidth + m * 2;
    if (y < -m) y += this.fieldHeight + m * 2;

    const index = this.shapes.indexOf(shape);
    shape.fadeTween?.stop(); // drop any in-flight fade so it can't mutate a torn-down shape
    shape.container.destroy(true);
    shape.shadow.destroy();
    shape.echo?.destroy();
    this.disposeRecvShadow(shape);
    this.shapes.splice(index, 1);

    this.spawnShapeFromPool(this.nextFreePoolIndex(shape.poolIndex), x, y);
  }

  /**
   * Next pool index (cycling from `from + 1`) not held by any live shape. Shapes wrap at
   * different rates, so naive `poolIndex + 1` counters drift into collisions — several
   * shapes rendering the same recipe (and identical baked texture) at once.
   */
  private nextFreePoolIndex(from: number): number {
    const used = new Set(this.shapes.map((s) => s.poolIndex));
    const n = this.shapePool.length;
    for (let i = 1; i <= n; i++) {
      const candidate = (from + i) % n;
      if (!used.has(candidate)) return candidate;
    }
    return (from + 1) % n; // more live shapes than recipes — duplicates unavoidable
  }

  // ---------- SHAPE TEXTURE BAKING ----------
  // Phaser 4's setMask()/createGeometryMask() only works on the Canvas renderer — under
  // WebGL it's a no-op — so each recipe is baked once into a canvas texture instead.
  // Fill and detail patterns are drawn inside ctx.clip() (exact intersection with the
  // silhouette, partial dots included); the border is stroked unclipped so it stays
  // crisp and straddles the edge. Textures are cached per pool recipe.

  private ensureShapeTexture(poolIndex: number): string {
    const key = `shape-recipe-${poolIndex}`;
    if (this.textures.exists(key)) return key;

    const recipe = this.shapePool[poolIndex]!;
    const res = this.TEXTURE_RES;
    const pad = this.TEXTURE_PAD;
    const box = recipe.size + pad * 2;

    const canvasTex = this.textures.createCanvas(key, box * res, box * res)!;
    this.bodyCanvasByRecipe.set(poolIndex, canvasTex);
    const ctx = canvasTex.context;
    ctx.clearRect(0, 0, box * res, box * res); // pooled canvases may hold stale pixels
    ctx.save();
    ctx.scale(res, res);
    ctx.translate(box / 2, box / 2);

    // Fill + detail, clipped to the exact silhouette.
    ctx.save();
    this.traceShapePath(ctx, recipe.type, recipe.size);
    ctx.clip();
    if (recipe.fillMode === 'solid') {
      ctx.fillStyle = cssColor(recipe.color);
      ctx.fillRect(-box / 2, -box / 2, box, box);
      this.drawSolidDetail(ctx, recipe);
    } else if (recipe.fillMode === 'patternDots' || recipe.fillMode === 'patternStripes') {
      this.drawPattern(ctx, recipe.size, recipe.color, recipe.fillMode);
    }
    ctx.restore();

    // Border — same path, stroked without the clip. Round joins/caps so a thin border
    // doesn't pinch or clip at sharp corners (the default miter join gets cut off there,
    // reading as the outline thinning and the fill biting into it).
    this.traceShapePath(ctx, recipe.type, recipe.size);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (recipe.borderWeight !== 'none') {
      ctx.lineWidth = recipe.borderWeight === 'thick' ? 7 : 2.5;
      ctx.strokeStyle = cssColor(PALETTE.ink);
      ctx.stroke();
    } else if (recipe.fillMode === 'outline') {
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssColor(recipe.color);
      ctx.stroke();
    }

    ctx.restore();
    canvasTex.refresh(); // upload to the GPU under WebGL
    return key;
  }

  private ensureShadowTexture(poolIndex: number): string {
    const key = `shape-recipe-${poolIndex}-shadow`;
    if (this.textures.exists(key)) return key;

    // Flat ink silhouette of everything the body texture drew (fill, patterns, border),
    // via source-in compositing — the shadow always matches the rendered shape exactly.
    this.ensureShapeTexture(poolIndex); // guarantees the body canvas is baked + cached
    const bodyCanvas = this.bodyCanvasByRecipe.get(poolIndex)!.canvas;

    const shadowTex = this.textures.createCanvas(key, bodyCanvas.width, bodyCanvas.height)!;
    const ctx = shadowTex.context;
    ctx.clearRect(0, 0, bodyCanvas.width, bodyCanvas.height);
    ctx.drawImage(bodyCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = cssColor(PALETTE.ink);
    ctx.fillRect(0, 0, bodyCanvas.width, bodyCanvas.height);
    ctx.globalCompositeOperation = 'source-over';
    shadowTex.refresh();
    // Kept for the received-shadow compositor, which draws these silhouettes into a
    // per-shape canvas and clips them to the receiver.
    this.shadowCanvasByRecipe.set(poolIndex, shadowTex.canvas);
    return key;
  }

  private ensureEchoTexture(poolIndex: number): string {
    const key = `shape-recipe-${poolIndex}-echo`;
    if (this.textures.exists(key)) return key;

    const recipe = this.shapePool[poolIndex]!;
    const res = this.TEXTURE_RES;
    const pad = this.TEXTURE_PAD;
    const box = recipe.size + pad * 2;

    const echoTex = this.textures.createCanvas(key, box * res, box * res)!;
    const ctx = echoTex.context;
    ctx.clearRect(0, 0, box * res, box * res);
    ctx.save();
    ctx.scale(res, res);
    ctx.translate(box / 2, box / 2);
    this.traceShapePath(ctx, recipe.type, recipe.size);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = cssColor(PALETTE.navy);
    ctx.stroke();
    ctx.restore();
    echoTex.refresh();
    return key;
  }

  private traceShapePath(ctx: CanvasRenderingContext2D, type: ShapeType, size: number) {
    const half = size / 2;
    ctx.beginPath();
    switch (type) {
      case 'rect':
        ctx.roundRect(-half, -half, size, size, size * 0.16);
        break;
      case 'circle':
        ctx.arc(0, 0, half, 0, Math.PI * 2);
        break;
      case 'diamond': {
        // A real diamond — rotated square sized so its diagonal fits the same bbox.
        // (Previously drawn as another rounded rect, which read as a duplicate type.)
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
      default:
        ctx.moveTo(0, -half);
        ctx.lineTo(half, half);
        ctx.lineTo(-half, half);
        ctx.closePath();
        break;
    }
  }

  private drawSolidDetail(ctx: CanvasRenderingContext2D, recipe: ShapeRecipe) {
    const { size, detail, detailColor, detailAlpha } = recipe;
    if (detail === 'none') return;
    const half = size / 2;

    if (detail === 'dots') {
      ctx.fillStyle = cssColor(detailColor, detailAlpha);
      const spacing = size / 5;
      for (let yy = -half; yy < half; yy += spacing) {
        for (let xx = -half; xx < half; xx += spacing) {
          ctx.beginPath();
          ctx.arc(xx + spacing / 2, yy + spacing / 2, spacing * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (detail === 'stripes') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      const stripeWidth = size / 8;
      for (let xx = -half; xx < half; xx += stripeWidth * 2) {
        ctx.fillRect(xx, -half, stripeWidth, size);
      }
    } else if (detail === 'twotone') {
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + t * 0.18})`;
        ctx.fillRect(-half, -half + t * size, size, size / steps + 1);
      }
    }
  }

  private drawPattern(ctx: CanvasRenderingContext2D, size: number, color: number, mode: FillMode) {
    const half = size / 2;
    ctx.fillStyle = cssColor(color, 0.95);
    if (mode === 'patternDots') {
      const spacing = size / 7;
      for (let yy = -half; yy < half + spacing; yy += spacing) {
        for (let xx = -half; xx < half + spacing; xx += spacing) {
          ctx.beginPath();
          ctx.arc(xx, yy, spacing * 0.34, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      const stripeWidth = size / 6;
      for (let xx = -half; xx < half + stripeWidth; xx += stripeWidth * 2) {
        ctx.fillRect(xx, -half - 10, stripeWidth, size + 20);
      }
    }
  }

  // ---------- RESIZE ----------

  private handleResize(gameSize: Phaser.Structs.Size) {
    const oldW = this.fieldWidth;
    const oldH = this.fieldHeight;
    this.fieldWidth = gameSize.width;
    this.fieldHeight = gameSize.height;
    const o = this.GRID_OVERSCAN;
    this.grid.setSize(this.fieldWidth + o * 2, this.fieldHeight + o * 2);
    if (oldW !== this.fieldWidth || oldH !== this.fieldHeight) {
      this.redistributeDecor(oldW, oldH);
    }
  }

  /**
   * Re-spread the drifting decor over a resized field. The shapes and squiggles were
   * stratified over the OLD extended field, and the torus wrap re-enters them on whatever
   * the CURRENT field period is — so growing the window (reddit's fullscreen toggle)
   * otherwise leaves a permanent empty band over the newly exposed area: the drift is
   * diagonal (x−y invariant), so wrapped re-entries can never migrate into it. Scaling
   * every position proportionally is measure-preserving — the even stratified spread
   * survives — and the density-based shape count is topped up (or trimmed) for the new
   * area so a grown field doesn't just spread the same few shapes thinner.
   */
  private redistributeDecor(oldW: number, oldH: number) {
    const m = this.WRAP_MARGIN;

    // Squiggles wrap over x ∈ [-m, W+m] but a tight y ∈ [-30, H+30] (see update()).
    const sqX = (this.fieldWidth + m * 2) / (oldW + m * 2);
    const sqY = (this.fieldHeight + 60) / (oldH + 60);
    for (const s of this.squiggles) {
      s.obj.x = (s.obj.x + m) * sqX - m;
      s.obj.y = (s.obj.y + 30) * sqY - 30;
    }

    // Scaling alone keeps the OLD count, so a grown field just spreads the same marks thinner
    // and leaves a sparse void; top up (or trim) to the new area's density like the shapes do.
    // Trim by fading out RANDOM live marks, not the array tail: the array is ordered
    // top-to-bottom from the initial row-major scatter, so removing the end always deleted the
    // lowest marks — a big instant shrink collapsed the even spread into a cluster. Random
    // removal keeps it uniform; the fade (and revive on grow) is handled by retire/fadeIn.
    const wantSq = this.squiggleTargetCount();
    let liveSq = this.liveSquiggleCount();
    while (liveSq > wantSq) {
      const s = this.randomLiveSquiggle();
      if (!s) break;
      this.retireSquiggle(s);
      liveSq--;
    }
    while (liveSq < wantSq) {
      // Revive a still-fading-out mark first, so a shrink-then-grow reverses instead of
      // churning; only spawn a genuinely new one (fading in) when none are left to revive.
      const reviving = this.squiggles.find((s) => s.retiring);
      if (reviving) {
        this.fadeInSquiggle(reviving);
      } else {
        this.spawnSquiggle(
          this.rngFloat(-this.WRAP_MARGIN, this.fieldWidth + this.WRAP_MARGIN),
          this.rngFloat(-this.SQUIGGLE_Y_MARGIN, this.fieldHeight + this.SQUIGGLE_Y_MARGIN),
          true
        );
      }
      liveSq++;
    }

    const fx = (this.fieldWidth + m * 2) / (oldW + m * 2);
    const fy = (this.fieldHeight + m * 2) / (oldH + m * 2);
    for (const shape of this.shapes) {
      const nx = (shape.container.x + m) * fx - m;
      const ny = (shape.container.y + m) * fy - m;
      // The echo trails its body at a fixed offset, moved per-frame by the same drift
      // delta — carry it along by this jump too. The ground/received shadows reposition
      // themselves from the container on the next update tick.
      if (shape.echo) {
        shape.echo.x += nx - shape.container.x;
        shape.echo.y += ny - shape.container.y;
      }
      shape.container.setPosition(nx, ny);
    }

    // Keep the ~1 shape per 290k px² density (matches spawnFloatingShapes). Fade out random
    // live shapes on shrink and revive/fade in on grow — same lifecycle as the squiggles.
    const extW = this.fieldWidth + m * 2;
    const extH = this.fieldHeight + m * 2;
    const want = Math.max(8, Math.round((extW * extH) / 290_000));
    let liveSh = this.liveShapeCount();
    while (liveSh > want) {
      const sh = this.randomLiveShape();
      if (!sh) break;
      this.retireShape(sh);
      liveSh--;
    }
    let cursor = Math.floor(this.rng() * this.shapePool.length);
    while (liveSh < want) {
      const reviving = this.shapes.find((s) => s.retiring);
      if (reviving) {
        this.fadeInShape(reviving);
      } else {
        this.spawnShapeFromPool(
          this.nextFreePoolIndex(cursor),
          -m + this.rng() * extW,
          -m + this.rng() * extH,
          true
        );
        cursor = this.shapes[this.shapes.length - 1]!.poolIndex;
      }
      liveSh++;
    }

    // Newly spawned pieces default to visible — re-assert clean mode if it's on.
    if (this.decorHidden) this.setDecorHidden(true);
  }

  /**
   * Clean mode: hide/show the drifting shapes + squiggles for players who find them
   * distracting. The gridlines go too — a perpetually scrolling grid is exactly the kind
   * of ambient motion that gives sensitive players motion sickness — leaving a flat
   * off-white page. Hidden decor also stops animating — no point moving what isn't
   * drawn — and resumes from where it left off when shown again.
   */
  isDecorHidden(): boolean {
    return this.decorHidden;
  }

  setDecorHidden(hidden: boolean) {
    this.decorHidden = hidden;
    this.grid.setTexture(hidden ? 'grid-cell-plain' : 'grid-cell');
    for (const s of this.squiggles) s.obj.setVisible(!hidden);
    for (const shape of this.shapes) {
      shape.container.setVisible(!hidden);
      shape.shadow.setVisible(!hidden);
      shape.echo?.setVisible(!hidden);
      shape.recv?.setVisible(!hidden);
    }
  }

  // ---------- UPDATE LOOP ----------

  override update(_time: number, delta: number) {
    const started = PERF ? performance.now() : 0;
    if (!this.decorHidden) {
      const gridSpeed = 0.03;
      // Scroll the grid by moving the whole sprite and wrapping within ONE cell — never by
      // nudging tilePosition. On the Canvas renderer, changing tilePosition marks the TileSprite
      // dirty, which re-runs a createPattern + fillRect over its ENTIRE (oversized, ~3.4M-px)
      // canvas every frame (see Phaser TileSprite.updateCanvas: the fill canvas is sized in game
      // units, so it's unaffected by render resolution) — that single fill was ~44ms/frame on a
      // mobile Canvas fallback, i.e. the whole frame budget. The grid is periodic at GRID_CELL,
      // so translating the sprite up to one cell and wrapping is pixel-identical but leaves the
      // sprite un-dirtied: its pattern canvas is filled once and just blitted thereafter.
      this.gridScroll = (this.gridScroll + gridSpeed * delta) % this.GRID_CELL;
      const o = this.GRID_OVERSCAN;
      this.grid.setPosition(-o - this.gridScroll, -o - this.gridScroll);
      // Horizontal wrap sits well past the right edge (like the shapes) so a parallax-
      // offset camera never catches a squiggle popping back in. Vertical stays tight — the
      // camera only pans on X, so the bottom re-entry is always off-screen already.
      const sxWrap = this.WRAP_MARGIN;
      for (const s of this.squiggles) {
        s.obj.x -= s.speed * delta;
        s.obj.y -= s.speed * delta;
        if (s.obj.x < -sxWrap) s.obj.x += this.fieldWidth + sxWrap * 2;
        if (s.obj.y < -30) s.obj.y += this.fieldHeight + 60;
      }

      for (const shape of [...this.shapes]) {
        const dx = shape.speed * delta;
        shape.container.x -= dx;
        shape.container.y -= dx;
        shape.container.rotation += shape.rotSpeed * delta;

        // Ground shadow trails the shape at a fixed down-right throw set by its height.
        const throw_ = this.shadowThrow(shape.height); // gap to the page == full height
        shape.shadow
          .setPosition(shape.container.x + throw_, shape.container.y + throw_)
          .setRotation(shape.container.rotation);

        if (shape.echo) {
          shape.echo.x -= dx;
          shape.echo.y -= dx;
          shape.echo.rotation = shape.container.rotation;
        }

        // Reflect the fade tween (spawn/despawn glide) onto every part each frame.
        this.applyShapeFade(shape);

        // A retiring shape is fading out in place; don't torus-wrap it (that would teleport a
        // half-faded shape across the field). Live shapes wrap as before.
        if (
          !shape.retiring &&
          (shape.container.x < -this.WRAP_MARGIN || shape.container.y < -this.WRAP_MARGIN)
        ) {
          this.respawnShape(shape);
        }
      }

      // Cast-on shadows are re-projected on a throttle from the shapes' fresh positions
      // (they drift slowly enough that a few frames' staleness is invisible — see the field).
      if (++this.recvShadowFrame >= this.RECV_SHADOW_INTERVAL) {
        this.recvShadowFrame = 0;
        this.updateReceivedShadows();
      }
    }

    if (PERF) perf.bg.add(performance.now() - started);
  }

  // ---------- SHADOW PROJECTION ----------

  /** Down-right throw (light off the top-left) for a shadow spanning a height `gap`. */
  private shadowThrow(gap: number): number {
    return SHADOW_MIN_OFFSET + Math.max(0, gap) * SHADOW_GAP_OFFSET;
  }

  /** Effective on-screen radius of a shape, used for the coarse "does this shadow land on
   *  that shape" overlap test (the exact shape comes from the silhouette clip). */
  private shapeRadius(shape: FloatingShape): number {
    return (this.shapePool[shape.poolIndex]!.size + this.TEXTURE_PAD * 2) / 2;
  }

  /** For each shape, gather the nearer shapes whose shadow actually falls on it and paint
   *  those onto its clipped-to-silhouette canvas — the shadow "climbs" onto the raised
   *  shape at the reduced (H−h) throw, stepping in from where it lay on the page. */
  private updateReceivedShadows() {
    for (const receiver of this.shapes) {
      const rr = this.shapeRadius(receiver);
      const casters: FloatingShape[] = [];
      for (const caster of this.shapes) {
        if (caster === receiver) continue;
        const gap = caster.height - receiver.height;
        if (gap <= SHADOW_HEIGHT_EPS) continue; // must be meaningfully nearer to cast onto it
        const throw_ = this.shadowThrow(gap);
        const sx = caster.container.x + throw_;
        const sy = caster.container.y + throw_;
        const reach = rr + this.shapeRadius(caster);
        if (Phaser.Math.Distance.Squared(sx, sy, receiver.container.x, receiver.container.y) < reach * reach) {
          casters.push(caster);
        }
      }
      if (casters.length === 0) {
        if (receiver.recv) receiver.recv.setVisible(false);
        continue;
      }
      this.paintReceivedShadow(receiver, casters);
    }
  }

  /** (Re)draw the shadows `casters` cast onto `receiver`, clipped to the receiver's exact
   *  silhouette, into its personal canvas — then show it just above the receiver's body. */
  private paintReceivedShadow(receiver: FloatingShape, casters: FloatingShape[]) {
    const res = this.TEXTURE_RES;
    const recipeR = this.shapePool[receiver.poolIndex]!;
    const boxR = recipeR.size + this.TEXTURE_PAD * 2;
    const rTex = this.ensureRecvShadow(receiver, boxR * res);
    const ctx = rTex.context;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, boxR * res, boxR * res);
    ctx.save();
    ctx.scale(res, res);
    ctx.translate(boxR / 2, boxR / 2); // receiver-local frame, receiver centred + unrotated

    // Rotate world offsets into the receiver's local frame (its canvas is displayed rotated
    // by the receiver's own spin, so the silhouette clip lines up with its body).
    const cos = Math.cos(-receiver.container.rotation);
    const sin = Math.sin(-receiver.container.rotation);
    for (const caster of casters) {
      const gap = caster.height - receiver.height;
      const throw_ = this.shadowThrow(gap);
      const wx = caster.container.x + throw_ - receiver.container.x;
      const wy = caster.container.y + throw_ - receiver.container.y;
      const lx = wx * cos - wy * sin;
      const ly = wx * sin + wy * cos;
      const casterCanvas = this.shadowCanvasByRecipe.get(caster.poolIndex);
      if (!casterCanvas) continue;
      const boxC = this.shapePool[caster.poolIndex]!.size + this.TEXTURE_PAD * 2;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(caster.container.rotation - receiver.container.rotation);
      ctx.drawImage(casterCanvas, -boxC / 2, -boxC / 2, boxC, boxC);
      ctx.restore();
    }

    // Clip the union down to the receiver's silhouette.
    const recvCanvas = this.shadowCanvasByRecipe.get(receiver.poolIndex);
    if (recvCanvas) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(recvCanvas, -boxR / 2, -boxR / 2, boxR, boxR);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    rTex.refresh();

    receiver
      .recv!.setPosition(receiver.container.x, receiver.container.y)
      .setRotation(receiver.container.rotation)
      .setAlpha(SHADOW_ALPHA * receiver.fade) // honour the shape's fade
      .setVisible(!this.decorHidden);
  }

  /** Lazily create (or fetch) a receiver's clipped received-shadow canvas + display image,
   *  sized to its supersampled bounding box, sitting just above its body. */
  private ensureRecvShadow(shape: FloatingShape, dim: number): Phaser.Textures.CanvasTexture {
    if (shape.recvKey) return this.textures.get(shape.recvKey) as Phaser.Textures.CanvasTexture;
    const key = `recv-shadow-${this.recvCounter++}`;
    const tex = this.textures.createCanvas(key, dim, dim)!;
    shape.recvKey = key;
    shape.recv = this.add
      .image(shape.container.x, shape.container.y, key)
      .setScale(1 / this.TEXTURE_RES)
      .setAlpha(SHADOW_ALPHA)
      .setDepth(shape.container.depth + RECV_SHADOW_DEPTH_GAP);
    return tex;
  }

  /** Tear down a shape's received-shadow image + its canvas texture (on respawn). */
  private disposeRecvShadow(shape: FloatingShape) {
    shape.recv?.destroy();
    if (shape.recvKey) this.textures.remove(shape.recvKey);
    shape.recv = null;
    shape.recvKey = null;
  }
}
