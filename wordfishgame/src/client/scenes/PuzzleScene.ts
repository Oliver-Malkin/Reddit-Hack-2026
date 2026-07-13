import * as Phaser from 'phaser';
import { WordTile, CELL_W } from '../puzzle/WordTile';
import type { TileFxName, TileHost } from '../puzzle/WordTile';
import { bottomSafeInset } from '../viewport';
import { Chain } from '../puzzle/Chain';
import { OnScreenKeyboard } from '../puzzle/Keyboard';
import { IconButton } from '../puzzle/IconButton';
import { createDecorToggle, drawDecorGlyph } from '../puzzle/decorToggle';
import { HelpPopup } from '../puzzle/HelpPopup';
import { SoundFx } from '../puzzle/SoundFx';
import { WinPopup } from '../puzzle/WinPopup';
import { scatterHomes } from '../puzzle/scatter';
import { activePuzzle, puzzleForDifficulty } from '../puzzle/puzzles';
import { getBootDailyDay } from '../puzzle/remote';
import { galleryRows } from '../puzzle/gallery';
import type { Difficulty, Puzzle } from '../puzzle/types';
import { PALETTE } from '../theme';
import { debugEnabled, perf } from '../debug';
import { copyText } from '../clipboard';
import { showPuzzleEditor } from '../puzzle/editor/PuzzleEditor';
import { BackgroundScene } from './BackgroundScene';
import { slideCameraIn, transitionToPage, jumpToPage, isTransitioning } from './pageTransition';
import type { PageEnterData } from './pageTransition';

/** 'gallery' shows one row per link type for design review; 'puzzle' plays a daily puzzle. */
const MODE: 'gallery' | 'puzzle' = 'puzzle';

/** Data the puzzle is launched/woken with: which edge to slide in from + which puzzle.
 *  `puzzle` (a user-created / previewed puzzle) takes precedence over `difficulty` (which
 *  selects one of the built-in dailies). `preview` marks an in-editor preview, so the
 *  top-left control returns to the creator's form rather than the home menu. */
type PuzzleEnterData = Partial<PageEnterData> & {
  difficulty?: Difficulty;
  puzzle?: Puzzle;
  preview?: boolean;
  /** For a published community puzzle: its title/author/url, used by the win-share text. */
  customMeta?: { title: string; author: string; url: string };
};

/** When the debug HUD is on, attribute per-frame time to tiles vs. chains. */
const PERF = debugEnabled();

/** Minimum gap between a tile's edge and the canvas edge. */
const LAYOUT_MARGIN = 12;

/**
 * Tiles are scaled so at least this many letter-cells span the canvas edge-to-edge, even
 * when the widest word is short. Without this cap a short widest word sits at full scale and
 * only ~8 cells fit across a phone (~390 logical px), leaving the chains between tiles
 * cramped; requiring ~15 roughly halves the tile size there and opens up room to read the
 * links. Wide screens are unaffected — 15 cells fit well under full scale.
 */
const MIN_VISIBLE_CELLS = 15;

/**
 * Interactive puzzle layer — runs on top of BackgroundScene. Owns the word tiles,
 * the link chains between them, all pointer/keyboard input, sound effects, and the
 * win flow (confetti + popup). As the TileHost it arbitrates which tile is focused
 * for typing and which is being dragged.
 */
export class PuzzleScene extends Phaser.Scene implements TileHost {
  private tiles = new Map<string, WordTile>();
  private tileList: WordTile[] = [];
  private chains: Chain[] = [];
  private keyboard: OnScreenKeyboard | null = null;
  private buttons: IconButton[] = [];
  private backButton: IconButton | null = null;
  private cleanButton: IconButton | null = null;
  private help: HelpPopup | null = null;
  private focused: WordTile | null = null;
  private activePointerTile: WordTile | null = null;
  private sfx = new SoundFx();
  private confetti: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private winPopup: WinPopup | null = null;
  private won = false;
  // The puzzle currently on the board, its difficulty (for the share recap), and which of
  // its hidden words are solved so far.
  private currentPuzzle: Puzzle = activePuzzle;
  private currentDifficulty: Difficulty = 'easy';
  private solvedHidden = new Set<string>();
  // True when this board is an in-editor preview (back arrow → creator's form, not the menu).
  private isPreview = false;
  private previewBadge: Phaser.GameObjects.Text | null = null;
  // Set when playing a published community puzzle — drives the win-share text.
  private customMeta: { title: string; author: string; url: string } | null = null;
  // True while a page transition is playing — input is locked so it can't be interrupted.
  private transitioning = false;
  // Shared layout state, set by recomputeLayoutMetrics() and read by the clamps below.
  private tileScale = 1;
  private playBottom = 0;

  constructor() {
    super('PuzzleScene');
  }

  create() {
    // Built once and kept across sleep/wake: textures, particles, keyboard, controls, input.
    Chain.bakeTextures(this);
    this.buildConfettiEmitter();
    this.keyboard = new OnScreenKeyboard(this, {
      onKey: (key) => this.routeKey(key),
      onToggle: () => this.applyLayout(),
    });
    this.buildControls();
    this.wireInput();

    // Load the puzzle we were launched with and (if arriving from the menu) slide it in.
    this.enter(this.scene.settings.data as PuzzleEnterData | undefined);

    // Re-flow everything when the canvas resizes (orientation change, devvit webview
    // resize). Tiles glide to their new homes via their follow-smoothing.
    this.scale.on('resize', () => {
      this.keyboard?.layout();
      this.applyLayout();
    });

    // Woken from the menu again — reload the chosen puzzle and slide back in.
    this.events.on(Phaser.Scenes.Events.WAKE, (_sys: unknown, data: PuzzleEnterData) =>
      this.enter(data)
    );
  }

  /** (Re)load the board for this entry and slide it in from the given edge. Runs on first
   *  launch and on every wake, so choosing a different difficulty rebuilds cleanly. */
  private enter(data?: PuzzleEnterData) {
    this.transitioning = false;
    this.won = false;
    // A win card from the previous visit would otherwise linger over the new puzzle.
    this.winPopup?.destroy();
    this.winPopup = null;
    for (const b of this.allButtons()) b.setEnabled(true);
    // The clean toggle is shared with the menu; re-sync its glyph to the current state.
    const bg = this.scene.get('BackgroundScene') as BackgroundScene;
    this.cleanButton?.setFace((f) => drawDecorGlyph(f, bg.isDecorHidden()));
    this.keyboard?.setMinimized(false);

    // Preview vs. daily: the top-left control is a back arrow (→ form) in preview, else the
    // home glyph (→ menu). A "PREVIEW" badge makes it obvious this puzzle isn't published.
    this.isPreview = data?.preview ?? false;
    this.customMeta = data?.customMeta ?? null;
    this.backButton?.setGlyph((g) =>
      this.isPreview ? this.drawBackArrowGlyph(g) : this.drawHomeGlyph(g)
    );
    this.updatePreviewBadge();

    this.clearBoard();
    if (MODE === 'gallery') this.buildGallery();
    else if (data?.puzzle) this.loadCustomPuzzle(data.puzzle);
    else this.loadPuzzle(data?.difficulty ?? 'easy');
    // Let each chain's rope push away from the others so lines stay separate.
    for (const chain of this.chains) chain.setPeers(this.chains);
    this.applyLayout(true);

    if (data?.enterFrom) slideCameraIn(this, data.enterFrom);
    else this.cameras.main.setScroll(0, 0);
  }

  /** Build the daily puzzle for a difficulty onto the (already cleared) board. */
  private loadPuzzle(difficulty: Difficulty) {
    this.currentDifficulty = difficulty;
    // A daily post is frozen to the day it was created (getBootDailyDay); fall back to the
    // live UTC day for local preview / legacy posts (puzzleForDifficulty's default).
    const day = getBootDailyDay();
    this.currentPuzzle =
      day != null ? puzzleForDifficulty(difficulty, day) : puzzleForDifficulty(difficulty);
    this.buildPuzzle(this.currentPuzzle);
  }

  /** Build a user-created / previewed puzzle onto the (already cleared) board. Difficulty
   *  is treated as 'easy' for share/recap purposes since custom puzzles aren't graded. */
  private loadCustomPuzzle(puzzle: Puzzle) {
    this.currentDifficulty = 'easy';
    this.currentPuzzle = puzzle;
    this.buildPuzzle(puzzle);
  }

  /** Destroy every tile and chain so the board can be rebuilt (difficulty change / re-entry). */
  private clearBoard() {
    for (const tile of this.tileList) tile.destroy();
    for (const chain of this.chains) chain.destroy();
    this.tiles.clear();
    this.tileList = [];
    this.chains = [];
    this.solvedHidden.clear();
    this.focused = null;
    this.activePointerTile = null;
  }

  private allButtons(): IconButton[] {
    return this.backButton ? [...this.buttons, this.backButton] : this.buttons;
  }

  /** One row per link type — all words shown (no hidden answers) so the chains can be
   *  compared side by side. Tiles stay draggable for poking at how the chains stretch. */
  private buildGallery() {
    for (const row of galleryRows) {
      const left = new WordTile(this, 0, 0, this, `${row.type}-l`, row.left, false);
      const right = new WordTile(this, 0, 0, this, `${row.type}-r`, row.right, false);
      this.tileList.push(left, right);
      // Gallery rows are their own pair; other rows sit far away, so obstacle-routing
      // isn't important here — pass the pair itself (both get filtered as endpoints).
      this.chains.push(new Chain(this, row.type, left, right, this.tileList));
    }
  }

  private buildPuzzle(puzzle: Puzzle) {
    // Tiles are created at the origin; applyLayout() (which knows the canvas size and
    // keyboard footprint) snaps them into place right after.
    for (const word of puzzle.words) {
      const tile = new WordTile(this, 0, 0, this, word.id, word.text, word.hidden);
      this.tiles.set(word.id, tile);
      this.tileList.push(tile);
    }

    for (const link of puzzle.links) {
      const from = this.tiles.get(link.from);
      const to = this.tiles.get(link.to);
      if (!from || !to) {
        console.warn(`Puzzle link references unknown word id: ${link.from} -> ${link.to}`);
        continue;
      }
      // Chain draws below tiles; for hypernym links `from` must be the superset. All
      // tiles are passed as obstacles so the arc routes around any word in its way.
      this.chains.push(new Chain(this, link.type, from, to, this.tileList));
    }
  }

  // ---------- CONTROLS (back / shuffle / help / clean) ----------

  /** Corner controls: a "back to menu" home button sits alone in the top-LEFT (navigation,
   *  away from the tools); shuffle, help and clean-mode form the top-RIGHT cluster. */
  private buildControls() {
    const back = new IconButton(this, 0, 0, {
      onTap: () => this.onBackTap(),
      draw: (g) => this.drawHomeGlyph(g),
    });
    const shuffle = new IconButton(this, 0, 0, {
      onTap: () => this.shuffleTiles(),
      draw: (g) => this.drawShuffleGlyph(g),
    });
    const help = new IconButton(this, 0, 0, {
      onTap: () => this.openHelp(),
      label: '?',
    });
    // Clean mode: hide the drifting background shapes/squiggles. Shared with the menu — the
    // state lives on BackgroundScene, so both toggles stay in sync.
    const clean = createDecorToggle(this, () => this.sfx.tap());
    for (const b of [back, shuffle, help, clean]) b.setDepth(80);
    this.backButton = back;
    this.cleanButton = clean;
    this.buttons = [shuffle, help, clean];
  }

  /** Top-left control: back to the creator's form in preview, else home to the menu. */
  private onBackTap() {
    if (this.isPreview) this.returnToEditor();
    else this.returnToMenu();
  }

  /** Home is always available — if the help sheet is up, close it first so navigating out
   *  never gets swallowed by an open modal. */
  private closeHelp() {
    if (!this.help) return;
    this.help.destroy();
    this.help = null;
  }

  /** Return to the main menu: this board slides off to the right while the menu slides in
   *  from the left, and the background parallax settles back to its resting view. */
  private returnToMenu() {
    if (this.transitioning || isTransitioning()) return;
    this.closeHelp();
    this.transitioning = true;
    this.sfx.tap();
    for (const b of this.allButtons()) b.setEnabled(false);
    transitionToPage(this, 'MenuScene', {}, 'right', 0);
  }

  /** From a preview, return to the still-alive editor form. The overlay is revealed first
   *  (instantly, covering everything), then the board→menu swap JUMPS behind it — sliding
   *  pages under a full-screen overlay would only be glimpsed as a glitch. */
  private returnToEditor() {
    if (this.transitioning || isTransitioning()) return;
    this.closeHelp();
    if (!showPuzzleEditor()) {
      // No live editor (shouldn't happen in preview) — fall back to the menu.
      this.returnToMenu();
      return;
    }
    this.transitioning = true;
    this.sfx.tap();
    jumpToPage(this, 'MenuScene', { reopenEditor: true }, 0);
  }

  /** Create/destroy the small "PREVIEW" badge to match the current mode; positioned in
   *  positionButtons(). */
  private updatePreviewBadge() {
    this.previewBadge?.destroy();
    this.previewBadge = null;
    if (!this.isPreview) return;
    const badge = this.add.text(0, 0, 'PREVIEW', {
      fontFamily: '"Arial Black", Arial, sans-serif',
      fontSize: '13px',
      fontStyle: '900',
      color: '#ffffff',
      backgroundColor: '#2b2d6e',
      padding: { left: 10, right: 10, top: 5, bottom: 5 },
    });
    badge.setOrigin(0.5).setDepth(80).setLetterSpacing(2);
    this.previewBadge = badge;
  }

  /** A simple house outline — the back-to-menu glyph. */
  private drawHomeGlyph(g: Phaser.GameObjects.Graphics) {
    g.lineStyle(3, PALETTE.ink, 1);
    g.beginPath();
    g.moveTo(-9, 0); // roof left
    g.lineTo(0, -9); // apex
    g.lineTo(9, 0); // roof right
    g.strokePath();
    g.beginPath();
    g.moveTo(-6, -1);
    g.lineTo(-6, 9); // left wall
    g.lineTo(6, 9); // floor
    g.lineTo(6, -1); // right wall
    g.strokePath();
    // Door.
    g.strokeRect(-2, 3, 4, 6);
  }

  /** A left-pointing arrow — the preview "back to editor" glyph. */
  private drawBackArrowGlyph(g: Phaser.GameObjects.Graphics) {
    g.lineStyle(3, PALETTE.ink, 1);
    g.lineBetween(-9, 0, 9, 0); // shaft
    g.beginPath();
    g.moveTo(-2, -7); // upper barb
    g.lineTo(-9, 0); // tip
    g.lineTo(-2, 7); // lower barb
    g.strokePath();
  }

  /** Two arrows crossing — the standard shuffle symbol. */
  private drawShuffleGlyph(g: Phaser.GameObjects.Graphics) {
    g.lineStyle(3, PALETTE.ink, 1);
    const head = (x: number, y: number, dx: number, dy: number) => {
      const a = Math.atan2(dy, dx);
      const s = 5;
      g.lineBetween(x, y, x - Math.cos(a - 0.5) * s, y - Math.sin(a - 0.5) * s);
      g.lineBetween(x, y, x - Math.cos(a + 0.5) * s, y - Math.sin(a + 0.5) * s);
    };
    // Down-left → up-right, and up-left → down-right, both ending in a rightward head.
    g.lineBetween(-9, 7, 9, -7);
    head(9, -7, 2, -1.5);
    g.lineBetween(-9, -7, 9, 7);
    head(9, 7, 2, 1.5);
  }

  private openHelp() {
    if (this.help) return;
    for (const b of this.buttons) b.setEnabled(false);
    this.sfx.tap();
    this.help = new HelpPopup(this, {
      onClose: () => {
        this.help = null;
        for (const b of this.buttons) b.setEnabled(true);
      },
    });
  }

  private get modalOpen(): boolean {
    return this.help !== null;
  }

  /**
   * Fling every tile to a fresh RANDOM position across the play area (see scatterHomes).
   * This is the escape hatch for dragging a tile off the canvas (you can't lose it) and
   * doubles as a fresh look at the board: the spots are random but spread out, so tiles land
   * scattered-but-readable rather than piled up, and always safely back on-screen.
   */
  private shuffleTiles() {
    if (this.tileList.length === 0 || this.modalOpen) return;
    this.recomputeLayoutMetrics();
    const homes = scatterHomes(this.tileList, {
      width: this.scale.width,
      bottom: this.playBottom,
      scale: this.tileScale,
      margin: LAYOUT_MARGIN,
    });
    this.tileList.forEach((tile, i) => tile.setHome(homes[i]!.x, homes[i]!.y));
    this.sfx.drop();
  }

  // ---------- RESPONSIVE LAYOUT ----------

  /** Shared tile scale + play-area bottom for the current canvas. The webview is far
   *  smaller than a desktop tab (and portrait on phones), so the widest word is scaled
   *  to fit across the canvas and the keyboard's footprint is carved off the bottom. */
  private recomputeLayoutMetrics() {
    const W = this.scale.width;
    const H = this.scale.height;
    // Keep the play area clear of BOTH the keyboard and the bottom-unsafe strip behind the
    // browser's URL bar (see bottomSafeInset) — otherwise a tile's home slot or a dragged
    // tile could sit under the bar off-screen.
    const reserved = Math.max(this.keyboard?.reservedHeight() ?? 0, bottomSafeInset());
    this.playBottom = Math.max(H - reserved, H * 0.45);
    const widest = Math.max(...this.tileList.map((t) => t.boxWidth));
    const n = this.tileList.length;
    // Base scale: the widest word fits across the canvas, capped so a minimum number of
    // letter-cells span the width. That minimum GROWS with the tile count — a small board
    // wants ~MIN_VISIBLE_CELLS across, a busy board needs more cells (smaller tiles) so five
    // words don't crowd the screen. Crucially this cap is orientation-independent: an earlier
    // landscape-only "same-row" shrink made tiles jump LARGER the moment the window narrowed
    // past the portrait threshold, and it's dead logic now that every tile gets its own row
    // (see computeSlots).
    const minCells = MIN_VISIBLE_CELLS + Math.max(0, n - 3) * 3;
    const maxScale = Math.min(1, W / (minCells * CELL_W));
    const scale = Phaser.Math.Clamp((W - LAYOUT_MARGIN * 2) / widest, 0.4, maxScale);
    this.tileScale = scale;
    for (const t of this.tileList) t.setBaseScale(this.tileScale);
    for (const c of this.chains) c.setLayoutScale(this.tileScale);
  }

  /** Clamp a desired centre so the (scaled) tile stays fully on canvas / in the play band. */
  private clampX(tile: WordTile, x: number): number {
    const half = (tile.boxWidth / 2) * this.tileScale + LAYOUT_MARGIN;
    return Phaser.Math.Clamp(x, half, this.scale.width - half);
  }

  private clampY(tile: WordTile, y: number): number {
    const half = (tile.boxHeight / 2) * this.tileScale + LAYOUT_MARGIN;
    return Phaser.Math.Clamp(y, half, this.playBottom - half);
  }

  /** The default home positions, one per tile (portrait stacks; landscape zigzags). */
  private computeSlots(): { x: number; y: number }[] {
    const W = this.scale.width;
    const H = this.scale.height;
    const availH = this.playBottom;
    const n = this.tileList.length;

    if (MODE === 'gallery') {
      const top = 70;
      const rows = n / 2;
      const step = rows > 1 ? (availH - 60 - top) / (rows - 1) : 0;
      return this.tileList.map((tile, idx) => ({
        x: this.clampX(tile, W * (idx % 2 === 0 ? 0.24 : 0.76)),
        y: top + step * Math.floor(idx / 2),
      }));
    }

    const portrait = W < H * 0.9;

    // Every tile gets its OWN y, stepping monotonically down the play band and spaced by at
    // least a full tile height, so two tiles can never share a row and collide. The old
    // landscape layout placed tiles on just two alternating rows, which overlapped badly when
    // a board had several wide words on the same row (see the hard daily). x still zig-zags —
    // narrow in portrait, a wide diagonal in landscape — so the chains read as diagonals.
    const tileH = (this.tileList[0]?.boxHeight ?? 58) * this.tileScale;
    // Spacing between tile centres is bounded on BOTH sides: at least a full tile height so
    // tiles never overlap, and at most ~2.4× so a tall play area (e.g. the keyboard tucked
    // away, giving the full screen height) doesn't fling the tiles apart to the far edges and
    // run the chain to the very bottom. The bounded stack is then centred vertically in the
    // play area, so it sits comfortably in the middle by default rather than reaching an edge.
    // (Dragging or shuffling can still park a tile low — that's the player's call; this only
    // governs the default home layout.)
    const minGap = tileH + 16;
    const maxGap = tileH * 2.4;
    const bandTop = Math.max(64, availH * 0.14);
    const bandBottom = availH - Math.max(52, availH * 0.1);
    let step = n > 1 ? (bandBottom - bandTop) / (n - 1) : 0;
    step = Phaser.Math.Clamp(step, minGap, maxGap);
    const totalH = step * (n - 1);
    // Centre the stack in the play area; never start above the top controls, and if the
    // min-gap forced it taller than the space (many tiles on a short screen) the drag clamp
    // keeps the lowest tiles onscreen.
    const top = Math.max(bandTop, (availH - totalH) / 2);

    // x fraction across the canvas: portrait alternates two narrow columns; landscape spreads
    // into a diagonal (single tile centred), so the stepped-down tiles read as a diagonal.
    // The landscape span is kept off the far edges (0.2–0.8, not 0.12–0.88) so a wide word's
    // tile isn't jammed against the canvas edge and the chains don't run edge-to-edge.
    const fxFor = (i: number): number => {
      if (portrait) return i % 2 === 0 ? 0.32 : 0.68;
      if (n === 1) return 0.5;
      return 0.2 + (0.6 * i) / (n - 1);
    };

    return this.tileList.map((tile, i) => ({
      x: this.clampX(tile, W * fxFor(i)),
      y: top + step * i,
    }));
  }

  private positionButtons() {
    const W = this.scale.width;
    const r = this.buttons[0]?.radius ?? 20;
    const inset = LAYOUT_MARGIN + 4 + r;
    const y = inset;
    // Right-aligned row in `buttons` order: shuffle sits in the corner, help to its left.
    this.buttons.forEach((b, i) => {
      b.setPosition(W - inset - i * (r * 2 + 10), y);
    });
    // Back-to-menu button alone in the top-left corner.
    this.backButton?.setPosition(inset, y);
    // "PREVIEW" badge sits centred alongside the top controls.
    this.previewBadge?.setPosition(W / 2, y);
  }

  /** Place tiles at their default slots + position the corner controls. `snap` puts
   *  tiles there instantly (initial layout); otherwise they glide via setHome. */
  private applyLayout(snap = false) {
    if (this.tileList.length === 0) return;
    this.recomputeLayoutMetrics();
    this.positionButtons();
    const slots = this.computeSlots();
    this.tileList.forEach((tile, i) => {
      const { x, y } = slots[i]!;
      if (snap) tile.setPosition(x, y);
      tile.setHome(x, y);
    });
  }

  // ---------- INPUT ----------

  /** One key from either keyboard. With nothing focused, a letter or backspace wakes
   *  the first unsolved answer tile — so on a phone you can just start typing. */
  private routeKey(key: string) {
    if (this.modalOpen) return;
    if (!this.focused && (/^[a-zA-Z]$/.test(key) || key === 'Backspace')) {
      const target = this.tileList.find((t) => t.editable);
      if (!target) return;
      // A far-right localX puts the caret at the first empty cell (focus clamps it).
      this.focusTile(target, target.boxWidth);
    }
    this.focused?.pressKey(key);
  }

  private wireInput() {
    this.input.on(
      'gameobjectdown',
      (pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        if (this.modalOpen || !(obj instanceof WordTile)) return;
        this.activePointerTile = obj;
        obj.beginPointer(pointer);
      }
    );
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.activePointerTile?.pointerMove(pointer);
    });
    const release = (pointer: Phaser.Input.Pointer) => {
      const tile = this.activePointerTile;
      this.activePointerTile = null;
      tile?.pointerUp(pointer);
    };
    this.input.on('pointerup', release);
    this.input.on('pointerupoutside', release);

    // A press that lands on empty space (no tile under it) clears typing focus.
    this.input.on(
      'pointerdown',
      (_pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
        if (!over || over.length === 0) this.clearFocus();
      }
    );

    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return; // browser shortcuts pass through
      const key = event.key;
      const isLetter = /^[a-zA-Z]$/.test(key);
      if (key === 'Backspace') event.preventDefault(); // don't let the webview navigate back
      // Physical presses light up the matching on-screen key.
      if (isLetter || key === 'Backspace') this.keyboard?.flashKey(key);
      this.routeKey(key);
    });
  }

  // ---------- WIN FLOW ----------

  private buildConfettiEmitter() {
    // A tiny white rounded square, tinted per-particle from the Memphis palette.
    if (!this.textures.exists('confetti-bit')) {
      const tex = this.textures.createCanvas('confetti-bit', 20, 20)!;
      const ctx = tex.context;
      ctx.clearRect(0, 0, 20, 20);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(2, 2, 16, 16, 4);
      ctx.fill();
      tex.refresh();
    }

    // One persistent emitter in explode mode — burst on demand via explode(n, x, y).
    this.confetti = this.add.particles(0, 0, 'confetti-bit', {
      speed: { min: 220, max: 520 },
      angle: { min: 225, max: 315 }, // fan upward; gravity brings it back down
      gravityY: 1100,
      lifespan: { min: 900, max: 1600 },
      scale: { start: 0.9, end: 0.35 },
      alpha: { start: 1, end: 0 },
      rotate: { start: 0, end: 540 },
      tint: [PALETTE.pink, PALETTE.cyan, PALETTE.yellow, PALETTE.green, PALETTE.purple, PALETTE.red],
      emitting: false,
    });
    this.confetti.setDepth(90);
  }

  tileSolved(tile: WordTile) {
    if (this.won) return;
    this.confetti?.explode(30, tile.x, tile.y - tile.displayHeight / 2);
    this.solvedHidden.add(tile.wordId);

    // Win only once EVERY hidden word is filled (the hard puzzle has two).
    const hiddenIds = this.currentPuzzle.words.filter((w) => w.hidden).map((w) => w.id);
    const allSolved = hiddenIds.every((id) => this.solvedHidden.has(id));
    if (!allSolved) {
      this.sfx.chime(); // one down, more to go
      return;
    }

    this.won = true;
    this.sfx.win();
    // Typing is over — tuck the keyboard away so the celebration owns the canvas.
    this.keyboard?.setMinimized(true);
    this.cameras.main.flash(250, 255, 255, 255);

    const answers = hiddenIds.map((id) => this.tiles.get(id)?.answer ?? '').filter(Boolean);

    // Let the confetti fly for a beat, then spring the card in with a second burst.
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 650,
      onComplete: () => {
        const cx = this.scale.width / 2;
        const cy = this.scale.height * 0.42;
        const popup = new WinPopup(this, cx, cy, {
          answers,
          onShare: () => this.shareResult(),
        });
        popup.once(Phaser.GameObjects.Events.DESTROY, () => {
          if (this.winPopup === popup) this.winPopup = null;
        });
        this.winPopup = popup;
        this.confetti?.explode(36, cx, cy - 130);
      },
    });
  }

  // One sea-creature per hidden word — a spoiler-free tally of how many words were caught,
  // a light nod to the name without spelling anything out.
  private static readonly HIDDEN_ICONS = ['🐟', '🦀', '🐙', '🦑', '🦐', '🐠', '🐡', '🦞'];

  /** Copies a short, spoiler-free, copy-pasteable brag; returns whether the write worked. */
  private async shareResult(): Promise<boolean> {
    const ok = await copyText(this.buildShareText());
    if (ok) this.sfx.chime();
    return ok;
  }

  /**
   * The share blurb: two short spoiler-free lines with a creature per hidden word (a tally of
   * what was caught, giving nothing away), and a link to play. For a community puzzle it
   * credits the author and links straight to that post; for the daily it points at the
   * subreddit and teases the streak. Kept brief on purpose — a wall of identical pasted text
   * is what reads as spam.
   */
  private buildShareText(): string {
    const hiddenCount = this.currentPuzzle.words.filter((w) => w.hidden).length;
    const catch_ = Array.from(
      { length: Math.max(1, hiddenCount) },
      (_, i) => PuzzleScene.HIDDEN_ICONS[i % PuzzleScene.HIDDEN_ICONS.length]
    ).join('');

    // Solving your own not-yet-published puzzle in the editor's preview isn't the daily —
    // don't claim a daily catch (or leak a wrong difficulty) in the copied text.
    if (this.isPreview) {
      return (
        `Test-caught ${catch_} in a WordFish puzzle I'm building!\n` +
        `Make your own at r/wordfishgame`
      );
    }

    if (this.customMeta) {
      const where = this.customMeta.url
        ? `Play it → ${this.customMeta.url}`
        : 'Find it at r/wordfishgame';
      return (
        `I caught ${catch_} in u/${this.customMeta.author}'s WordFish "${this.customMeta.title}"!\n` +
        where
      );
    }

    const difficulty = this.currentDifficulty === 'hard' ? 'Hard' : 'Easy';
    return (
      `Today's Wordfish (${difficulty}) — ${catch_} caught!\n` +
      `Play the daily at r/wordfishgame — how long can you keep your streak?`
    );
  }

  // ---------- TileHost ----------

  focusTile(tile: WordTile, localX: number) {
    if (this.focused && this.focused !== tile) this.focused.blur();
    this.focused = tile;
    tile.focus(localX);
  }

  clearFocus() {
    this.focused?.blur();
    this.focused = null;
  }

  beginTileDrag(_tile: WordTile) {
    this.clearFocus(); // dragging and typing are mutually exclusive
  }

  endTileDrag(_tile: WordTile) {}

  /** Drag bounds: same clamps the layout uses, so a dragged tile stays fully on canvas AND
   *  above the keyboard band — it can't be lost off an edge or parked under the keys. */
  clampTilePosition(tile: WordTile, x: number, y: number): { x: number; y: number } {
    return { x: this.clampX(tile, x), y: this.clampY(tile, y) };
  }

  playFx(name: TileFxName) {
    this.sfx[name]();
  }

  override update(time: number, delta: number) {
    if (!PERF) {
      for (const tile of this.tileList) tile.tick(delta);
      for (const chain of this.chains) chain.update(time);
      return;
    }
    // Debug-only: attribute frame time to tiles vs. chains for the HUD.
    const t0 = performance.now();
    for (const tile of this.tileList) tile.tick(delta);
    const t1 = performance.now();
    for (const chain of this.chains) chain.update(time);
    const t2 = performance.now();
    perf.tiles.add(t1 - t0);
    perf.chains.add(t2 - t1);
  }
}
