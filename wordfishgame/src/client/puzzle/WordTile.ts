import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

const CELL_W = 46;
const CELL_H = 58;
const RADIUS = 10;
const BORDER = 5;
const SHADOW_OFFSET = 6;
const MOVE_THRESHOLD = 6; // px of pointer travel before a press becomes a drag

export type TileFxName = 'tap' | 'erase' | 'grab' | 'drop' | 'wrong' | 'win';

/** The scene owns focus, z-order, sound, and win state; the tile calls back through this. */
export type TileHost = {
  focusTile(tile: WordTile, localX: number): void;
  clearFocus(): void;
  beginTileDrag(tile: WordTile): void;
  endTileDrag(tile: WordTile): void;
  tileSolved(tile: WordTile): void;
  playFx(name: TileFxName): void;
};

type Mode = 'idle' | 'pending' | 'dragging';

/**
 * A draggable word made of letter boxes: white cells, thick ink border, offset shadow.
 *
 * Two kinds:
 *  - a fixed clue word, and
 *  - the hidden answer, whose cells the player types into.
 *
 * Both drag from anywhere on the tile. Drag vs. type is disambiguated by MOTION, not
 * region (which is what touch users expect): press-and-move past MOVE_THRESHOLD starts a
 * drag; a press that releases without moving is a tap — which on the answer tile focuses
 * it for typing. So the whole tile is one big drag handle and one big "tap to type" zone
 * at once, with no thin border band or long-press to fight.
 *
 * Drag feel: squish on grab, exponentially-smoothed follow (~55 ms — soft but still
 * responsive), and a slight velocity tilt.
 */
export class WordTile extends Phaser.GameObjects.Container {
  readonly wordId: string;
  readonly answer: string;
  readonly boxWidth: number;
  readonly boxHeight: number;
  /** The word actually entered when solved — usually `answer`, but see `accept`. */
  solvedWith = '';

  private host: TileHost;
  private isHidden: boolean;
  private solved = false;
  /** Extra words (besides `answer`) that also count as correct. Empty for real puzzles so
   *  each has a unique solution; the tutorial uses it for its "non-obvious answer" gag. */
  private accept: string[];

  // letter state
  private slots: string[];
  private cellTexts: Phaser.GameObjects.Text[] = [];
  private caretGfx: Phaser.GameObjects.Graphics;
  private caretIndex = -1;
  private focused = false;
  private caretBlink = 0;
  private blinkOn = false;
  private announcedFull = false;

  // Layout scale for small canvases — every squish/pop tween is relative to this.
  private baseScale = 1;

  // drag state
  private mode: Mode = 'idle';
  private targetX: number;
  private targetY: number;
  private grabOffsetX = 0;
  private grabOffsetY = 0;
  private downX = 0;
  private downY = 0;
  private downLocalX = 0;
  private grabbed = false;
  private tilt = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    host: TileHost,
    wordId: string,
    text: string,
    hidden = false,
    accept: string[] = [],
  ) {
    super(scene, x, y);
    this.host = host;
    this.wordId = wordId;
    this.answer = text.toUpperCase();
    this.accept = accept.map((w) => w.toUpperCase());
    this.isHidden = hidden;
    this.targetX = x;
    this.targetY = y;

    const n = this.answer.length;
    this.slots = hidden ? new Array(n).fill('') : this.answer.split('');
    const w = (this.boxWidth = n * CELL_W + BORDER * 2);
    const h = (this.boxHeight = CELL_H);

    // Offset ink shadow (child, so it squishes and tilts with the tile).
    const shadow = scene.add.graphics();
    shadow.fillStyle(PALETTE.ink, 0.18);
    shadow.fillRoundedRect(-w / 2 + SHADOW_OFFSET, -h / 2 + SHADOW_OFFSET, w, h, RADIUS);
    this.add(shadow);

    // Body: white backing, thin cell separators, thick outer border.
    const body = scene.add.graphics();
    body.fillStyle(0xffffff, 1);
    body.fillRoundedRect(-w / 2, -h / 2, w, h, RADIUS);
    body.lineStyle(2, PALETTE.ink, 0.22);
    for (let i = 1; i < n; i++) {
      const sx = -w / 2 + BORDER + i * CELL_W;
      body.lineBetween(sx, -h / 2 + 7, sx, h / 2 - 7);
    }
    body.lineStyle(BORDER, PALETTE.ink, 1);
    body.strokeRoundedRect(-w / 2, -h / 2, w, h, RADIUS);
    this.add(body);

    // Caret overlay sits between the body and the letters.
    this.caretGfx = scene.add.graphics();
    this.add(this.caretGfx);

    // Letters.
    for (let i = 0; i < n; i++) {
      const cx = -w / 2 + BORDER + i * CELL_W + CELL_W / 2;
      const t = scene.add.text(cx, 1, '', {
        fontFamily: UI_FONT,
        fontSize: '28px',
        fontStyle: '900',
        color: '#1c1c1c',
      });
      t.setOrigin(0.5);
      this.add(t);
      this.cellTexts.push(t);
    }

    scene.add.existing(this);
    this.setDepth(10);

    // Interactive for hit-testing + cursor only — dragging is driven manually by the
    // scene so the border/center/long-press logic can live in one place. Phaser measures
    // a Container's hit-area local point from its TOP-LEFT (position minus half-size), so
    // the rect that covers the centered visual box is (0, 0, w, h) — NOT (-w/2, -h/2, …),
    // which shifts the hittable zone up-left and leaves dead spots.
    this.setSize(w, h);
    this.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });

    this.renderCells();
  }

  get editable(): boolean {
    return this.isHidden && !this.solved;
  }

  /** Layout scale for small canvases; the scene sets this whenever it re-flows. */
  setBaseScale(s: number) {
    if (Math.abs(s - this.baseScale) < 0.001) return;
    this.baseScale = s;
    // Any in-flight squish/pop tween targets the old scale — drop it and re-target
    // from the new base next gesture.
    this.scene.tweens.killTweensOf(this);
    this.setScale(s);
  }

  chainAnchor(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Distance from centre to the bbox edge along a unit direction — chains stop here. */
  edgeDistance(ux: number, uy: number): number {
    const hx = (this.boxWidth / 2) * Math.abs(this.scaleX);
    const hy = (this.boxHeight / 2) * Math.abs(this.scaleY);
    const tx = ux !== 0 ? hx / Math.abs(ux) : Number.POSITIVE_INFINITY;
    const ty = uy !== 0 ? hy / Math.abs(uy) : Number.POSITIVE_INFINITY;
    return Math.min(tx, ty);
  }

  // ---------- POINTER (called by the scene) ----------

  beginPointer(pointer: Phaser.Input.Pointer) {
    // worldX/worldY (not x/y): these are the camera-transformed coordinates, so the tile
    // tracks the pointer correctly whatever the camera's scroll or zoom — the latter matters
    // on high-DPI screens, where the camera is zoomed to render the buffer at device pixels.
    this.downX = pointer.worldX;
    this.downY = pointer.worldY;
    // Local coords (rotation is ~0, so dividing out scale is close enough).
    this.downLocalX = (pointer.worldX - this.x) / (this.scaleX || 1);
    // Every tile starts pending: it becomes a drag if the pointer travels, or a tap if
    // it's released in place. No region test — the whole surface does both jobs.
    this.mode = 'pending';
  }

  pointerMove(pointer: Phaser.Input.Pointer) {
    if (this.mode === 'idle') return;
    const moved = Math.hypot(pointer.worldX - this.downX, pointer.worldY - this.downY);

    if (this.mode === 'pending' && moved > MOVE_THRESHOLD) {
      this.startDrag(pointer);
    }

    if (this.mode === 'dragging') {
      this.targetX = pointer.worldX + this.grabOffsetX;
      this.targetY = pointer.worldY + this.grabOffsetY;
    }
  }

  pointerUp(pointer: Phaser.Input.Pointer) {
    const moved = Math.hypot(pointer.worldX - this.downX, pointer.worldY - this.downY);
    if (this.mode === 'dragging') {
      this.endDrag();
    } else if (this.mode === 'pending' && moved <= MOVE_THRESHOLD && this.editable) {
      this.host.focusTile(this, this.downLocalX); // tap in place → type
    }
    this.mode = 'idle';
  }

  private startDrag(pointer: Phaser.Input.Pointer) {
    this.mode = 'dragging';
    this.grabbed = true;
    this.grabOffsetX = this.x - pointer.worldX; // keep the grabbed point under the cursor
    this.grabOffsetY = this.y - pointer.worldY;
    this.targetX = this.x;
    this.targetY = this.y;
    this.setDepth(50);
    this.host.beginTileDrag(this);
    this.host.playFx('grab');
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      scaleX: 1.045 * this.baseScale,
      scaleY: 0.93 * this.baseScale,
      duration: 110,
      ease: 'Quad.easeOut',
    });
  }

  private endDrag() {
    this.grabbed = false;
    this.setDepth(this.solved ? 12 : 10);
    this.host.endTileDrag(this);
    this.host.playFx('drop');
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      scaleX: this.baseScale,
      scaleY: this.baseScale,
      duration: 300,
      ease: 'Back.easeOut',
    });
  }

  /** Home position for layout — the smoothed follow glides the tile there. */
  setHome(x: number, y: number) {
    if (this.mode === 'dragging') return;
    this.targetX = x;
    this.targetY = y;
  }

  // ---------- FOCUS + TYPING ----------

  focus(localX: number) {
    if (!this.editable) return;
    this.focused = true;
    // Caret lands on the tapped cell, but never past the first empty one — so a fresh
    // tap on an empty word starts at cell 0, tapping ahead of your progress snaps back
    // to where typing continues, and tapping a filled cell (or any cell once the word
    // is full) lets you go straight there to fix it. No gaps, no surprises.
    const tapped = this.cellFromLocalX(localX);
    const firstEmpty = this.slots.findIndex((s) => s === '');
    this.caretIndex = firstEmpty === -1 ? tapped : Math.min(tapped, firstEmpty);
    this.caretBlink = 0;
    this.blinkOn = true;
    this.renderCells();
  }

  blur() {
    this.focused = false;
    this.caretIndex = -1;
    this.renderCells();
  }

  private cellFromLocalX(localX: number): number {
    const rel = localX + this.boxWidth / 2 - BORDER;
    return Phaser.Math.Clamp(Math.floor(rel / CELL_W), 0, this.slots.length - 1);
  }

  /** One key of input — 'A'–'Z', 'Backspace', arrows, etc. Both the physical keyboard
   *  (via the scene's keydown listener) and the on-screen keyboard route through here. */
  pressKey(key: string) {
    if (!this.editable || !this.focused) return;
    const n = this.slots.length;

    if (/^[a-zA-Z]$/.test(key)) {
      // Overwrite the current cell and step right (parking on the last cell when full).
      this.slots[this.caretIndex] = key.toUpperCase();
      this.caretIndex = Math.min(this.caretIndex + 1, n - 1);
      this.host.playFx('tap');
    } else if (key === 'Backspace') {
      // Delete what's in the current cell if there is anything; only when it's already
      // empty does it step back and clear the previous cell. This matches what you'd
      // expect whether you're backspacing a run of letters or fixing a single tapped one.
      if (this.slots[this.caretIndex]) {
        this.slots[this.caretIndex] = '';
      } else if (this.caretIndex > 0) {
        this.caretIndex--;
        this.slots[this.caretIndex] = '';
      }
      this.host.playFx('erase');
    } else if (key === 'Delete') {
      this.slots[this.caretIndex] = '';
      this.host.playFx('erase');
    } else if (key === 'ArrowLeft') {
      this.caretIndex = Math.max(0, Math.min(this.caretIndex, n - 1) - 1);
    } else if (key === 'ArrowRight') {
      this.caretIndex = Math.min(n - 1, this.caretIndex + 1);
    } else if (key === 'Home') {
      this.caretIndex = 0;
    } else if (key === 'End') {
      this.caretIndex = n - 1;
    } else if (key === 'Enter' || key === 'Escape') {
      this.host.clearFocus();
      return;
    } else {
      return;
    }

    this.caretBlink = 0;
    this.blinkOn = true;
    this.checkFull();
    this.renderCells();
  }

  private checkFull() {
    const full = this.slots.every((s) => s !== '');
    if (!full) {
      this.announcedFull = false;
      return;
    }
    // A correct word always wins — even if the player fixed the last letter in place on
    // an already-full guess (which never dips back to non-full). The wrong-answer buzz,
    // by contrast, fires only once per fill so overwriting wrong→wrong doesn't spam it.
    const guess = this.slots.join('');
    if (guess === this.answer || this.accept.includes(guess)) {
      this.solvedWith = guess;
      this.solve();
    } else if (!this.announcedFull) {
      this.announcedFull = true;
      this.flashWrong();
    }
  }

  private solve() {
    this.solved = true;
    this.focused = false;
    this.caretIndex = -1;
    this.host.clearFocus();
    this.setDepth(12);
    this.renderCells();

    // Cells flip green with a left-to-right staggered pop (they're already green from
    // renderCells; reset to ink so each one visibly flips as its pop lands).
    this.cellTexts.forEach((cell, i) => {
      cell.setColor('#1c1c1c');
      this.scene.tweens.add({
        targets: cell,
        scaleX: 1.35,
        scaleY: 1.35,
        yoyo: true,
        duration: 120,
        delay: i * 60,
        ease: 'Quad.easeOut',
        onStart: () => cell.setColor('#27ae60'),
      });
    });

    // Whole-tile pop. (No glow filter here: enableFilters() renders the container to a
    // bounds-sized texture, which crops the thick border stroke that overflows those
    // bounds — leaving a permanently thin border. The staggered green flip, confetti,
    // and camera flash carry the celebration without touching the renderer.)
    this.scene.tweens.add({
      targets: this,
      scaleX: 1.08 * this.baseScale,
      scaleY: 1.08 * this.baseScale,
      yoyo: true,
      duration: 160,
      ease: 'Quad.easeOut',
    });

    // The host decides the sound: a full win jingle, or a lighter note when there are
    // still more hidden words to go (see PuzzleScene.tileSolved).
    this.host.tileSolved(this);
  }

  private flashWrong() {
    // The puzzle layer's camera does the shaking (background scene stays calm) —
    // this replaces a hand-rolled x-position tween that fought the drag smoothing.
    const cam = this.scene.cameras.main;
    cam.shake(180, 0.006);
    this.host.playFx('wrong');
    this.renderCells(true);
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 480,
      onComplete: () => this.renderCells(),
    });
  }

  private renderCells(wrong = false) {
    for (let i = 0; i < this.slots.length; i++) {
      const t = this.cellTexts[i]!;
      const letter = this.slots[i]!;
      const isCaret = this.focused && i === this.caretIndex;

      if (this.solved) {
        t.setText(letter).setColor('#27ae60');
      } else if (letter) {
        t.setText(letter).setColor(wrong ? '#ef3b3b' : '#1c1c1c');
      } else if (this.editable && !isCaret) {
        t.setText('?').setColor('#ff2f8f'); // "fill me" hint, hidden on the active cell
      } else {
        t.setText('');
      }
    }
    this.drawInputChrome();
  }

  private drawInputChrome() {
    const g = this.caretGfx;
    g.clear();
    // Only the unsolved answer tile gets input chrome; clue and solved tiles are plain.
    if (!this.editable) return;

    const w = this.boxWidth;
    const h = this.boxHeight;
    const uy = h / 2 - 11; // underline baseline

    for (let i = 0; i < this.slots.length; i++) {
      const cellLeft = -w / 2 + BORDER + i * CELL_W;
      const isCaret = this.focused && i === this.caretIndex;

      // Focus highlight box behind the active cell.
      if (isCaret) {
        g.fillStyle(PALETTE.yellow, 0.22);
        g.fillRoundedRect(cellLeft + 3, -h / 2 + 5, CELL_W - 6, h - 10, 6);
      }

      // Persistent pink "fill-in-the-blank" underline on every cell — the always-on
      // signal that this box still needs solving, even once it's full of letters. The
      // active cell's underline blinks to ink to double as the caret.
      const caretBlink = isCaret && this.blinkOn;
      g.fillStyle(caretBlink ? PALETTE.ink : PALETTE.pink, caretBlink ? 0.9 : 0.75);
      g.fillRoundedRect(cellLeft + 8, uy, CELL_W - 16, 3, 1.5);
    }
  }

  // ---------- FRAME TICK (called by the scene) ----------

  tick(delta: number) {
    if (this.focused) {
      this.caretBlink += delta;
      const on = this.caretBlink % 1000 < 550;
      if (on !== this.blinkOn) {
        this.blinkOn = on;
        this.drawInputChrome();
      }
    }

    const k = 1 - Math.exp(-delta / 55);
    const prevX = this.x;
    this.x += (this.targetX - this.x) * k;
    this.y += (this.targetY - this.y) * k;

    const vx = (this.x - prevX) / Math.max(delta, 1);
    const targetTilt = this.grabbed ? Phaser.Math.Clamp(vx * 0.05, -0.055, 0.055) : 0;
    this.tilt += (targetTilt - this.tilt) * (1 - Math.exp(-delta / 90));
    this.rotation = this.tilt;
  }
}
