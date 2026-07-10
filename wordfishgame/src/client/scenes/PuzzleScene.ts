import * as Phaser from 'phaser';
import { WordTile } from '../puzzle/WordTile';
import type { TileFxName, TileHost } from '../puzzle/WordTile';
import { Chain } from '../puzzle/Chain';
import { OnScreenKeyboard } from '../puzzle/Keyboard';
import { IconButton } from '../puzzle/IconButton';
import { createDecorToggle, drawDecorGlyph } from '../puzzle/decorToggle';
import { HelpPopup } from '../puzzle/HelpPopup';
import { SoundFx } from '../puzzle/SoundFx';
import { WinPopup } from '../puzzle/WinPopup';
import { activePuzzle, puzzleForDifficulty } from '../puzzle/puzzles';
import { galleryRows } from '../puzzle/gallery';
import type { Difficulty, Puzzle } from '../puzzle/types';
import { PALETTE } from '../theme';
import { debugEnabled, perf } from '../debug';
import { copyText } from '../clipboard';
import { BackgroundScene } from './BackgroundScene';
import { slideCameraIn, transitionToPage, isTransitioning } from './pageTransition';
import type { PageEnterData } from './pageTransition';

/** 'gallery' shows one row per link type for design review; 'puzzle' plays a daily puzzle. */
const MODE: 'gallery' | 'puzzle' = 'puzzle';

/** Data the puzzle is launched/woken with: which edge to slide in from + which puzzle. */
type PuzzleEnterData = Partial<PageEnterData> & { difficulty?: Difficulty };

/** When the debug HUD is on, attribute per-frame time to tiles vs. chains. */
const PERF = debugEnabled();

/** Minimum gap between a tile's edge and the canvas edge. */
const LAYOUT_MARGIN = 12;

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

    this.clearBoard();
    if (MODE === 'gallery') this.buildGallery();
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
    this.currentPuzzle = puzzleForDifficulty(difficulty);
    this.buildPuzzle(this.currentPuzzle);
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
      onTap: () => this.returnToMenu(),
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

  /** Return to the main menu: this board slides off to the right while the menu slides in
   *  from the left, and the background parallax settles back to its resting view. */
  private returnToMenu() {
    if (this.transitioning || this.modalOpen || isTransitioning()) return;
    this.transitioning = true;
    this.sfx.tap();
    for (const b of this.allButtons()) b.setEnabled(false);
    transitionToPage(this, 'MenuScene', {}, 'right', 0);
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
   * Randomly re-arrange the tiles. This is the escape hatch for dragging a tile off
   * the canvas (you can't lose it), and doubles as a fresh look at the layout: it
   * takes the current on-screen slots, shuffles which tile goes to which, and adds a
   * little jitter — so everything is always brought safely back on-screen.
   */
  private shuffleTiles() {
    if (this.tileList.length === 0 || this.modalOpen) return;
    this.recomputeLayoutMetrics();
    const slots = this.computeSlots();

    // Fisher–Yates on the slot order.
    const order = slots.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }

    const W = this.scale.width;
    this.tileList.forEach((tile, i) => {
      const slot = slots[order[i]!]!;
      const jx = Phaser.Math.FloatBetween(-W * 0.05, W * 0.05);
      const jy = Phaser.Math.FloatBetween(-24, 24);
      tile.setHome(this.clampX(tile, slot.x + jx), this.clampY(tile, slot.y + jy));
    });
    this.sfx.drop();
  }

  // ---------- RESPONSIVE LAYOUT ----------

  /** Shared tile scale + play-area bottom for the current canvas. The webview is far
   *  smaller than a desktop tab (and portrait on phones), so the widest word is scaled
   *  to fit across the canvas and the keyboard's footprint is carved off the bottom. */
  private recomputeLayoutMetrics() {
    const W = this.scale.width;
    const H = this.scale.height;
    this.playBottom = Math.max(H - (this.keyboard?.reservedHeight() ?? 0), H * 0.45);
    const widest = Math.max(...this.tileList.map((t) => t.boxWidth));
    const n = this.tileList.length;
    // Base scale: the widest word fits across the canvas.
    let scale = Phaser.Math.Clamp((W - LAYOUT_MARGIN * 2) / widest, 0.4, 1);
    // In the landscape zigzag, words share two rows (alternating), so tiles two apart in
    // index sit side by side. Shrink enough that same-row neighbours don't collide.
    const portrait = W < H * 0.9;
    if (MODE === 'puzzle' && !portrait && n > 2) {
      const gap = 40;
      const sameRowCenters = (W * 0.64 * 2) / (n - 1); // matches the fx step in computeSlots
      scale = Math.min(scale, Phaser.Math.Clamp((sameRowCenters - gap) / widest, 0.4, 1));
    }
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
    return this.tileList.map((tile, i) => {
      if (portrait) {
        // Stack down the canvas, nudged alternately so chains still read as diagonals.
        const bandTop = Math.max(64, availH * 0.16);
        const bandBottom = availH - Math.max(56, availH * 0.12);
        const step = n > 1 ? (bandBottom - bandTop) / (n - 1) : 0;
        return { x: this.clampX(tile, W * (i % 2 === 0 ? 0.38 : 0.62)), y: bandTop + step * i };
      }
      // The mock's gentle zigzag across the middle band.
      const fx = n === 1 ? 0.5 : 0.18 + (0.64 * i) / (n - 1);
      return { x: this.clampX(tile, W * fx), y: availH * (0.5 + (i % 2 === 0 ? -0.16 : 0.13)) };
    });
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
   * The share blurb: two short lines that give away nothing about the answers, name where
   * to play (the subreddit), and tee up the daily-streak hook. A creature per hidden word
   * stands in for what was solved. Kept brief on purpose — a wall of identical text pasted
   * into every comment is what reads as spam.
   */
  private buildShareText(): string {
    const hiddenCount = this.currentPuzzle.words.filter((w) => w.hidden).length;
    const catch_ = Array.from(
      { length: Math.max(1, hiddenCount) },
      (_, i) => PuzzleScene.HIDDEN_ICONS[i % PuzzleScene.HIDDEN_ICONS.length]
    ).join('');
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
