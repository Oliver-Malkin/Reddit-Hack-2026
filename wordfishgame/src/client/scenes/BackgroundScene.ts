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
};

type FloatingShape = {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Image;
  echo: Phaser.GameObjects.Image | null;
  speed: number;
  rotSpeed: number;
  poolIndex: number;
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
  private squiggles: Squiggle[] = [];
  private shapes: FloatingShape[] = [];
  private fieldWidth = 0;
  private fieldHeight = 0;

  private rng!: () => number;
  private shapePool: ShapeRecipe[] = [];
  // Baked body textures, kept by pool index so the shadow bake can read their canvas
  // back without casting the generic Texture the manager hands out.
  private bodyCanvasByRecipe = new Map<number, Phaser.Textures.CanvasTexture>();
  private readonly WRAP_MARGIN = 160;
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
    this.buildSquiggleTextures();
    this.scatterSquiggles();

    this.shapePool = this.buildShapePool();
    this.spawnFloatingShapes();

    this.scale.on('resize', this.handleResize, this);

    // Puzzle layer renders on top — launched after the background so scene order is stable.
    this.scene.launch('PuzzleScene');
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
    const cellSize = 60;
    const g = this.make.graphics({}, false);
    g.fillStyle(PALETTE.offWhite, 1);
    g.fillRect(0, 0, cellSize, cellSize);
    g.lineStyle(1, PALETTE.gridLine, 1);
    g.strokeRect(0, 0, cellSize, cellSize);
    g.generateTexture('grid-cell', cellSize, cellSize);
    g.destroy();

    this.grid = this.add
      .tileSprite(0, 0, this.fieldWidth, this.fieldHeight, 'grid-cell')
      .setOrigin(0, 0)
      .setDepth(0);
  }

  // ---------- SQUIGGLES ----------

  private buildSquiggleTextures() {
    for (const color of SQUIGGLE_COLORS) {
      this.drawZigzagTexture(`sq-zigzag-${color}`, color);
      this.drawRingTexture(`sq-ring-${color}`, color);
      this.drawDotClusterTexture(`sq-dots-${color}`, color);
      this.drawSparkTexture(`sq-spark-${color}`, color);
      this.drawPlusTexture(`sq-plus-${color}`, color);
      this.drawSlashTexture(`sq-slash-${color}`, color);
      this.drawDotTexture(`sq-dot-${color}`, color);
      this.drawWaveTexture(`sq-wave-${color}`, color);
    }
  }

  private drawZigzagTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(4, color, 1);
    g.beginPath();
    g.moveTo(2, 16);
    g.lineTo(9, 2);
    g.lineTo(16, 16);
    g.lineTo(23, 2);
    g.strokePath();
    g.generateTexture(key, 25, 18);
    g.destroy();
  }

  private drawRingTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(3, color, 1);
    g.strokeCircle(8, 8, 6);
    g.generateTexture(key, 16, 16);
    g.destroy();
  }

  private drawDotClusterTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.fillStyle(color, 1);
    const spacing = 8;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        g.fillCircle(4 + col * spacing, 4 + row * spacing, 2.5);
      }
    }
    g.generateTexture(key, spacing + 8, spacing + 8);
    g.destroy();
  }

  private drawSparkTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(2.5, color, 1);
    g.beginPath();
    g.moveTo(7, 0);
    g.lineTo(7, 14);
    g.moveTo(0, 7);
    g.lineTo(14, 7);
    g.moveTo(2, 2);
    g.lineTo(12, 12);
    g.moveTo(12, 2);
    g.lineTo(2, 12);
    g.strokePath();
    g.generateTexture(key, 14, 14);
    g.destroy();
  }

  private drawPlusTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(3.5, color, 1);
    g.beginPath();
    g.moveTo(8, 1);
    g.lineTo(8, 15);
    g.moveTo(1, 8);
    g.lineTo(15, 8);
    g.strokePath();
    g.generateTexture(key, 16, 16);
    g.destroy();
  }

  private drawSlashTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(3.5, color, 1);
    g.beginPath();
    g.moveTo(3, 14);
    g.lineTo(12, 2);
    g.strokePath();
    g.generateTexture(key, 15, 16);
    g.destroy();
  }

  private drawDotTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.fillStyle(color, 1);
    g.fillCircle(4, 4, 3.5);
    g.generateTexture(key, 8, 8);
    g.destroy();
  }

  private drawWaveTexture(key: string, color: number) {
    const g = this.make.graphics({}, false);
    g.lineStyle(3, color, 1);
    g.beginPath();
    g.moveTo(1, 6);
    for (let x = 1; x <= 24; x++) {
      g.lineTo(1 + x, 6 + Math.sin((x / 24) * Math.PI * 3) * 4);
    }
    g.strokePath();
    g.generateTexture(key, 26, 12);
    g.destroy();
  }

  private scatterSquiggles() {
    const motifs = ['zigzag', 'ring', 'dots', 'spark', 'plus', 'slash', 'dot', 'wave'];
    const targetCount = 32;

    const cols = Math.ceil(Math.sqrt((targetCount * this.fieldWidth) / this.fieldHeight));
    const rows = Math.ceil(targetCount / cols);
    const cellW = this.fieldWidth / cols;
    const cellH = this.fieldHeight / rows;

    let placed = 0;
    for (let row = 0; row < rows && placed < targetCount; row++) {
      for (let col = 0; col < cols && placed < targetCount; col++) {
        if (this.rng() < 0.15) continue;

        const x = col * cellW + this.rngFloat(0.2, 0.8) * cellW;
        const y = row * cellH + this.rngFloat(0.2, 0.8) * cellH;

        const motif = this.rngPick(motifs);
        const color = this.rngPick(SQUIGGLE_COLORS);
        const key = `sq-${motif}-${color}`;

        const img = this.add
          .image(x, y, key)
          .setRotation(this.rngFloat(0, Math.PI * 2))
          .setScale(this.rngFloat(0.9, 1.3))
          .setAlpha(0.85)
          .setDepth(1);

        this.squiggles.push({ obj: img, speed: this.rngFloat(0.03, 0.038) });
        placed++;
      }
    }
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

  private spawnShapeFromPool(poolIndex: number, x: number, y: number) {
    const idx = poolIndex % this.shapePool.length;
    const recipe = this.shapePool[idx]!;
    // Gentle drift — this sits behind word tiles the player is reading, so the
    // motion should register as ambient, not draw the eye.
    const speed = this.rngFloat(0.04, 0.075);

    // Shadow — an ink-flattened stamp of the baked body texture, so it matches what
    // the shape actually renders: outline-only shapes cast a border-ring shadow,
    // dot/stripe patterns cast per-dot shadows. Offset opposite the pan direction.
    const shadowOffset = 6 + speed * 40;
    const shadow = this.add
      .image(x + shadowOffset, y + shadowOffset, this.ensureShadowTexture(idx))
      .setScale(1 / this.TEXTURE_RES)
      .setAlpha(0.16)
      .setDepth(2);

    // Displaced echo outline — accent on a few recipes only. Baked from the SAME canvas
    // path as the body (like the shadow), so its silhouette can never drift out of sync
    // with the rendered shape — hand-drawn echo geometry once gave diamonds sharp
    // corners while their bodies were rounded.
    let echo: Phaser.GameObjects.Image | null = null;
    if (recipe.echo) {
      echo = this.add
        .image(x - 7, y - 5, this.ensureEchoTexture(idx))
        .setScale(1 / this.TEXTURE_RES)
        .setAlpha(0.45)
        .setDepth(2);
    }

    // Body + border come from a texture baked once per recipe (see ensureShapeTexture) —
    // Phaser 4 geometry masks are Canvas-renderer only, so clipping is done at bake
    // time with ctx.clip() instead: an exact fill∩silhouette intersection.
    const body = this.add
      .image(0, 0, this.ensureShapeTexture(idx))
      .setScale(1 / this.TEXTURE_RES);

    const container = this.add.container(x, y, [body]);
    container.setDepth(3);

    this.shapes.push({
      container,
      shadow,
      echo,
      speed,
      rotSpeed: this.rngFloat(-0.0002, 0.0002),
      poolIndex: idx,
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
    shape.container.destroy(true);
    shape.shadow.destroy();
    shape.echo?.destroy();
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

    // Border — same path, stroked without the clip.
    this.traceShapePath(ctx, recipe.type, recipe.size);
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
    this.fieldWidth = gameSize.width;
    this.fieldHeight = gameSize.height;
    this.grid.setSize(this.fieldWidth, this.fieldHeight);
  }

  // ---------- UPDATE LOOP ----------

  override update(_time: number, delta: number) {
    const started = PERF ? performance.now() : 0;
    const gridSpeed = 0.03;
    this.grid.tilePositionX += gridSpeed * delta;
    this.grid.tilePositionY += gridSpeed * delta;

    for (const s of this.squiggles) {
      s.obj.x -= s.speed * delta;
      s.obj.y -= s.speed * delta;
      if (s.obj.x < -30) s.obj.x += this.fieldWidth + 60;
      if (s.obj.y < -30) s.obj.y += this.fieldHeight + 60;
    }

    for (const shape of [...this.shapes]) {
      const dx = shape.speed * delta;
      shape.container.x -= dx;
      shape.container.y -= dx;
      shape.container.rotation += shape.rotSpeed * delta;

      shape.shadow.x -= dx;
      shape.shadow.y -= dx;
      shape.shadow.rotation = shape.container.rotation; // shadow tracks the shape's spin
      if (shape.echo) {
        shape.echo.x -= dx;
        shape.echo.y -= dx;
        shape.echo.rotation = shape.container.rotation;
      }

      if (shape.container.x < -this.WRAP_MARGIN || shape.container.y < -this.WRAP_MARGIN) {
        this.respawnShape(shape);
      }
    }

    if (PERF) perf.bgMs = performance.now() - started;
  }
}
