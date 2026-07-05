import Phaser from 'phaser';
import { WordTile } from '../puzzle/WordTile';
import type { TileHost } from '../puzzle/WordTile';
import { Chain } from '../puzzle/Chain';
import { activePuzzle } from '../puzzle/puzzles';
import { galleryRows } from '../puzzle/gallery';
import type { Puzzle } from '../puzzle/types';

/** 'gallery' shows one row per link type for design review; 'puzzle' plays activePuzzle. */
const MODE: 'gallery' | 'puzzle' = 'gallery';

/**
 * Interactive puzzle layer — runs on top of BackgroundScene. Owns the word tiles,
 * the link chains between them, and all pointer/keyboard input. As the TileHost it
 * arbitrates which tile is focused for typing and which is being dragged.
 */
export class PuzzleScene extends Phaser.Scene implements TileHost {
  private tiles = new Map<string, WordTile>();
  private tileList: WordTile[] = [];
  private chains: Chain[] = [];
  private focused: WordTile | null = null;
  private activePointerTile: WordTile | null = null;

  constructor() {
    super('PuzzleScene');
  }

  create() {
    Chain.bakeTextures(this);
    if (MODE === 'gallery') this.buildGallery();
    else this.buildPuzzle(activePuzzle);
    this.wireInput();
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
      const left = new WordTile(this, W * 0.24, y, this, `${row.type}-l`, row.left, false);
      const right = new WordTile(this, W * 0.76, y, this, `${row.type}-r`, row.right, false);
      this.tileList.push(left, right);
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
    this.input.on('gameobjectdown', (pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (!(obj instanceof WordTile)) return;
      this.activePointerTile = obj;
      obj.beginPointer(pointer);
    });
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
    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (!over || over.length === 0) this.clearFocus();
    });

    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.focused?.handleKey(event);
    });
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

  override update(time: number, delta: number) {
    for (const tile of this.tileList) tile.tick(delta);
    for (const chain of this.chains) chain.update(time);
  }
}
