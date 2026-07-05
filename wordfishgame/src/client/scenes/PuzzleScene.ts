import * as Phaser from 'phaser';
import { WordTile } from '../puzzle/WordTile';
import type { TileFxName, TileHost } from '../puzzle/WordTile';
import { Chain } from '../puzzle/Chain';
import { SoundFx } from '../puzzle/SoundFx';
import { WinPopup } from '../puzzle/WinPopup';
import { activePuzzle } from '../puzzle/puzzles';
import { galleryRows } from '../puzzle/gallery';
import type { Puzzle } from '../puzzle/types';
import { PALETTE } from '../theme';

/** 'gallery' shows one row per link type for design review; 'puzzle' plays activePuzzle. */
const MODE: 'gallery' | 'puzzle' = 'puzzle';

type TileLayout = { tile: WordTile; fx: number; fy: number };

/**
 * Interactive puzzle layer — runs on top of BackgroundScene. Owns the word tiles,
 * the link chains between them, all pointer/keyboard input, sound effects, and the
 * win flow (confetti + popup). As the TileHost it arbitrates which tile is focused
 * for typing and which is being dragged.
 */
export class PuzzleScene extends Phaser.Scene implements TileHost {
  private tiles = new Map<string, WordTile>();
  private tileList: WordTile[] = [];
  private layouts: TileLayout[] = [];
  private chains: Chain[] = [];
  private focused: WordTile | null = null;
  private activePointerTile: WordTile | null = null;
  private sfx = new SoundFx();
  private confetti: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private won = false;

  constructor() {
    super('PuzzleScene');
  }

  create() {
    Chain.bakeTextures(this);
    this.buildConfettiEmitter();
    if (MODE === 'gallery') this.buildGallery();
    else this.buildPuzzle(activePuzzle);
    this.wireInput();

    // Re-flow tile home positions when the canvas resizes (orientation change,
    // devvit webview resize). Tiles glide there via their follow-smoothing.
    this.scale.on('resize', () => {
      const W = this.scale.width;
      const H = this.scale.height;
      for (const { tile, fx, fy } of this.layouts) tile.setHome(W * fx, H * fy);
    });
  }

  /** One row per link type — all words shown (no hidden answers) so the chains can be
   *  compared side by side. Tiles stay draggable for poking at how the chains stretch. */
  private buildGallery() {
    const W = this.scale.width;
    const H = this.scale.height;
    const top = 80;
    const step = galleryRows.length > 1 ? (H - 140 - top) / (galleryRows.length - 1) : 0;

    galleryRows.forEach((row, i) => {
      const y = top + step * i;
      const fy = y / H;
      const left = new WordTile(this, W * 0.24, y, this, `${row.type}-l`, row.left, false);
      const right = new WordTile(this, W * 0.76, y, this, `${row.type}-r`, row.right, false);
      this.tileList.push(left, right);
      this.layouts.push({ tile: left, fx: 0.24, fy }, { tile: right, fx: 0.76, fy });
      this.chains.push(new Chain(this, row.type, left, right));
    });
  }

  private buildPuzzle(puzzle: Puzzle) {
    const W = this.scale.width;
    const H = this.scale.height;

    // Lay words out along a gentle zigzag across the middle band, like the mock —
    // staggered so chains read as diagonals, with room to drag things around.
    const n = puzzle.words.length;
    puzzle.words.forEach((word, i) => {
      const fx = n === 1 ? 0.5 : 0.2 + (0.6 * i) / (n - 1);
      const fy = 0.45 + (i % 2 === 0 ? -0.13 : 0.11);
      const tile = new WordTile(this, W * fx, H * fy, this, word.id, word.text, word.hidden);
      this.tiles.set(word.id, tile);
      this.tileList.push(tile);
      this.layouts.push({ tile, fx, fy });
    });

    for (const link of puzzle.links) {
      const from = this.tiles.get(link.from);
      const to = this.tiles.get(link.to);
      if (!from || !to) {
        console.warn(`Puzzle link references unknown word id: ${link.from} -> ${link.to}`);
        continue;
      }
      // Chain draws below tiles; for hypernym links `from` must be the superset.
      this.chains.push(new Chain(this, link.type, from, to));
    }
  }

  private wireInput() {
    this.input.on(
      'gameobjectdown',
      (pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        if (!(obj instanceof WordTile)) return;
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
      this.focused?.handleKey(event);
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
    // Win when every hidden tile is solved (currently one per puzzle).
    this.won = true;

    this.confetti?.explode(52, tile.x, tile.y - tile.boxHeight / 2);
    this.cameras.main.flash(250, 255, 255, 255);

    // Let the confetti fly for a beat, then spring the card in with a second burst.
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 650,
      onComplete: () => {
        const cx = this.scale.width / 2;
        const cy = this.scale.height * 0.42;
        new WinPopup(this, cx, cy, {
          answer: tile.answer,
          onShare: () => this.shareResult(),
        });
        this.confetti?.explode(36, cx, cy - 130);
      },
    });
  }

  /** Copies a Wordle-style share blurb; returns whether the clipboard write worked. */
  private async shareResult(): Promise<boolean> {
    const clues = this.tileList
      .filter((t) => !this.isHiddenTile(t))
      .map((t) => t.answer)
      .join(' ↔ ');
    const text = `I solved the Wordfish puzzle! 🐟 The hidden word linked ${clues}. Can you find it?`;
    try {
      await navigator.clipboard.writeText(text);
      this.sfx.chime();
      return true;
    } catch {
      return false;
    }
  }

  private isHiddenTile(tile: WordTile): boolean {
    return activePuzzle.words.some((w) => w.id === tile.wordId && w.hidden === true);
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
    for (const tile of this.tileList) tile.tick(delta);
    for (const chain of this.chains) chain.update(time);
  }
}
