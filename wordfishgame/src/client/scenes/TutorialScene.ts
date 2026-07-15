import Phaser from 'phaser';
import { WordTile } from '../puzzle/WordTile';
import type { TileFxName, TileHost } from '../puzzle/WordTile';
import { Chain } from '../puzzle/Chain';
import { OnScreenKeyboard } from '../puzzle/Keyboard';
import { IconButton } from '../puzzle/IconButton';
import { HelpPopup } from '../puzzle/HelpPopup';
import { createDecorToggle, drawDecorGlyph } from '../puzzle/decorToggle';
import { SoundFx } from '../puzzle/SoundFx';
import { TutorialCoach } from '../puzzle/TutorialCoach';
import type { CoachStep } from '../puzzle/TutorialCoach';
import { scatterHomes } from '../puzzle/scatter';
import { tileScaleFor } from '../puzzle/layout';
import { bottomSafeInset, isCoarsePointer } from '../viewport';
import { PALETTE } from '../theme';
import { slideCameraIn, transitionToPage, isTransitioning, SLIDE_DURATION } from './pageTransition';
import type { PageEnterData } from './pageTransition';
import type { BackgroundScene } from './BackgroundScene';

const LAYOUT_MARGIN = 12;

/** The intended answer, plus a curated set of tongue-in-cheek near-misses that also "work"
 *  (a cheerful mood, opposite-of-sad, five letters) — HAPPY is what the tutorial expects,
 *  the rest are an easter egg the coach ribs you for. */
const ANSWER = 'HAPPY';
const ALSO_ACCEPTED = ['MERRY', 'JOLLY', 'PERKY', 'SUNNY', 'BLISS'];

/** The scripted steps, in order. Copy + targets are built in coachStepFor(). */
const STEP_KEYS = ['intro', 'hidden', 'tile', 'antonym', 'isa', 'controls', 'solve', 'done'] as const;
type StepKey = (typeof STEP_KEYS)[number];

/**
 * The guided tutorial: a hand-held run through one tiny example puzzle —
 * SAD ↔ (HAPPY) → EMOTION — with a "coach" overlay that spotlights each part in turn and
 * explains it in a chirpy voice. Unlike the in-game HelpPopup (a quick cheat sheet), this
 * teaches by doing: the player actually types the answer, and the coach reacts — including
 * a gentle ribbing if they solve it with a clever non-obvious word.
 *
 * It is a "page" like the menu and puzzle (see pageTransition): it slides in from the menu
 * and, on Skip/Finish, slides back. Reused by wake, so re-entering always restarts clean.
 */
export class TutorialScene extends Phaser.Scene implements TileHost {
  private tiles = new Map<string, WordTile>();
  private tileList: WordTile[] = [];
  private chains: Chain[] = [];
  private antonymChain: Chain | null = null;
  private hypernymChain: Chain | null = null;
  private keyboard: OnScreenKeyboard | null = null;
  private coach: TutorialCoach | null = null;
  // The same top-right controls the puzzle has — shown here so the tutorial can point them out.
  private buttons: IconButton[] = [];
  private cleanButton: IconButton | null = null;
  // Top-LEFT home button — always available (sits above the coach dim), so you can bail to the
  // menu at any point in the tutorial, greyed screen or not.
  private backButton: IconButton | null = null;
  private help: HelpPopup | null = null;
  private sfx = new SoundFx();
  private focused: WordTile | null = null;
  private activePointerTile: WordTile | null = null;
  private tileScale = 1;
  // Bottom of the play band (above the keyboard), set by placeTiles and read by shuffle's clamp.
  private playBottom = 0;
  private stepIndex = 0;
  private finished = false;
  private skipped = false;
  private transitioning = false;
  private lastSolvedWith = '';

  constructor() {
    super('TutorialScene');
  }

  create() {
    Chain.bakeTextures(this);
    this.keyboard = new OnScreenKeyboard(this, {
      onKey: (key) => this.routeKey(key),
      onToggle: () => {
        this.placeTiles();
        // The keyboard opening/closing changes how far down the coach bubble may be dragged
        // (coachBottom() reads its reservedHeight()) — refresh the clamp so minimizing the
        // keyboard actually frees up that space instead of leaving the bubble stuck above
        // where the keyboard used to be.
        this.coach?.setBottomLimit(this.coachBottom());
      },
    });
    // Above the coach dim (depth 120), so the keyboard is never greyed out — the player
    // types on it during the tutorial.
    this.keyboard.setDepth(140);
    this.buildControls();
    this.wireInput();

    this.enter(this.scene.settings.data as Partial<PageEnterData> | undefined);

    this.scale.on('resize', () => {
      this.keyboard?.layout();
      this.positionControls();
      this.placeTiles();
      if (!this.finished && this.coach) this.showStep(this.stepIndex);
    });

    this.events.on(Phaser.Scenes.Events.WAKE, (_sys: unknown, data: Partial<PageEnterData>) =>
      this.enter(data)
    );
  }

  /** Reset and (re)build the example, then slide in and start from step one. */
  private enter(data?: Partial<PageEnterData>) {
    this.finished = false;
    this.skipped = false;
    this.transitioning = false;
    this.lastSolvedWith = '';
    this.stepIndex = 0;

    // A help panel left open from a previous visit would linger over the fresh board.
    this.help?.destroy();
    this.help = null;
    for (const b of this.buttons) b.setEnabled(true);
    // The clean toggle shares its state with the menu/puzzle — re-sync its glyph.
    const bg = this.scene.get('BackgroundScene') as BackgroundScene;
    this.cleanButton?.setFace((f) => drawDecorGlyph(f, bg.isDecorHidden()));

    this.clearBoard();
    this.build();
    this.placeTiles(true);
    for (const chain of this.chains) chain.setPeers(this.chains);
    // Back to the device default: open on touch (no physical keys), tucked away on desktop.
    this.keyboard?.setMinimized(!isCoarsePointer());

    this.coach = new TutorialCoach(this);

    // Slide the board in first, then fade the coach on once it has arrived — so the dim
    // never hard-pans in behind it (and the tiles get a clean entrance).
    if (data?.enterFrom) {
      slideCameraIn(this, data.enterFrom);
      this.time.delayedCall(SLIDE_DURATION, () => {
        if (!this.finished) this.showStep(0);
      });
    } else {
      this.cameras.main.setScroll(0, 0);
      this.showStep(0);
    }
  }

  private build() {
    const sad = new WordTile(this, 0, 0, this, 'sad', 'SAD', false);
    const happy = new WordTile(this, 0, 0, this, 'happy', ANSWER, true, ALSO_ACCEPTED);
    const emotion = new WordTile(this, 0, 0, this, 'emotion', 'EMOTION', false);
    for (const t of [sad, happy, emotion]) {
      this.tiles.set(t.wordId, t);
      this.tileList.push(t);
    }
    // SAD ↔ HAPPY (antonym), and EMOTION ⊃ HAPPY (is-a; from = the broader word).
    this.antonymChain = new Chain(this, 'antonym', sad, happy, this.tileList);
    this.hypernymChain = new Chain(this, 'hypernym', emotion, happy, this.tileList);
    this.chains.push(this.antonymChain, this.hypernymChain);
  }

  private clearBoard() {
    for (const t of this.tileList) t.destroy();
    for (const c of this.chains) c.destroy();
    this.coach?.destroy();
    this.tiles.clear();
    this.tileList = [];
    this.chains = [];
    this.antonymChain = null;
    this.hypernymChain = null;
    this.coach = null;
    this.focused = null;
    this.activePointerTile = null;
  }

  // ---------- LAYOUT ----------

  private placeTiles(snap = false) {
    if (this.tileList.length === 0) return;
    const W = this.scale.width;
    const H = this.scale.height;
    // Reserve the keyboard's footprint AND the bottom URL-bar strip (see bottomSafeInset), so
    // no tile's home slot — or a dragged tile — lands off-screen behind the bar.
    const reserved = Math.max(this.keyboard?.reservedHeight() ?? 0, bottomSafeInset());
    const playBottom = (this.playBottom = Math.max(H - reserved, H * 0.45));
    // Top of the play band sits below the corner controls, same as the real board.
    const r = this.buttons[0]?.radius ?? 20;
    const playTop = LAYOUT_MARGIN + 4 + r * 2 + 12;

    const portrait = W < H * 0.9;
    // Same sizing rule as the real board (see layout.tileScaleFor): the widest tile never
    // exceeds half the viewport and the tiles' height/area fit the play band, which keeps the
    // three example tiles compact instead of filling the screen.
    const scale = tileScaleFor(
      W,
      playBottom - playTop,
      this.tileList.map((t) => t.boxWidth)
    );
    this.tileScale = scale;
    for (const t of this.tileList) t.setBaseScale(scale);
    for (const c of this.chains) {
      c.setLayoutScale(scale);
      c.setBottomLimit(playBottom);
    }

    const spots: Record<string, { fx: number; y: number }> = portrait
      ? {
          sad: { fx: 0.38, y: playBottom * 0.24 },
          happy: { fx: 0.6, y: playBottom * 0.52 },
          emotion: { fx: 0.4, y: playBottom * 0.8 },
        }
      : {
          sad: { fx: 0.22, y: playBottom * 0.4 },
          happy: { fx: 0.5, y: playBottom * 0.66 },
          emotion: { fx: 0.78, y: playBottom * 0.4 },
        };

    for (const t of this.tileList) {
      const spot = spots[t.wordId]!;
      const x = this.clampX(t, spot.fx * W);
      const y = this.clampY(t, spot.y, playBottom);
      if (snap) t.setPosition(x, y);
      t.setHome(x, y);
    }
  }

  private clampX(tile: WordTile, x: number): number {
    const half = (tile.boxWidth / 2) * this.tileScale + LAYOUT_MARGIN;
    return Phaser.Math.Clamp(x, half, this.scale.width - half);
  }

  private clampY(tile: WordTile, y: number, playBottom: number): number {
    const half = (tile.boxHeight / 2) * this.tileScale + LAYOUT_MARGIN;
    return Phaser.Math.Clamp(y, half, playBottom - half);
  }

  // ---------- CONTROLS (the same top-right cluster the puzzle has) ----------

  /** Build shuffle / help / clean, so the tutorial can introduce the real in-game controls.
   *  Kept below the coach dim (depth 120) so they highlight cleanly when spotlit. */
  private buildControls() {
    const shuffle = new IconButton(this, 0, 0, {
      onTap: () => this.shuffleTiles(),
      draw: (g) => this.drawShuffleGlyph(g),
    });
    const help = new IconButton(this, 0, 0, { onTap: () => this.openHelp(), label: '?' });
    const clean = createDecorToggle(this, () => this.sfx.tap());
    for (const b of [shuffle, help, clean]) b.setDepth(80);
    this.cleanButton = clean;
    this.buttons = [shuffle, help, clean];

    // Home button, top-left. Raised above the coach dim (depth 120) so it's never greyed out —
    // it stays a live, obvious way back to the menu at every step of the tutorial.
    const back = new IconButton(this, 0, 0, {
      onTap: () => this.goHome(),
      draw: (g) => this.drawHomeGlyph(g),
    });
    back.setDepth(130);
    this.backButton = back;

    this.positionControls();
  }

  /** Right-aligned row in the top-right corner: shuffle in the corner, help then clean to its
   *  left; the home button sits alone in the top-left. */
  private positionControls() {
    const W = this.scale.width;
    const r = this.buttons[0]?.radius ?? 20;
    const inset = LAYOUT_MARGIN + 4 + r;
    this.buttons.forEach((b, i) => b.setPosition(W - inset - i * (r * 2 + 10), inset));
    this.backButton?.setPosition(inset, inset);
  }

  /** A simple house outline — the back-to-menu glyph (matches PuzzleScene's). */
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
    g.strokeRect(-2, 3, 4, 6); // door
  }

  /** Leave the tutorial and return to the main menu — the top-left home button, callable at
   *  any step. Same board→menu sweep the PLAY button uses. */
  private goHome() {
    if (this.transitioning || isTransitioning()) return;
    this.transitioning = true;
    this.finished = true;
    this.sfx.tap();
    this.coach?.setVisible(false); // drop the dim instantly so it can't smear on the way out
    transitionToPage(this, 'MenuScene', {}, 'right', 0);
  }

  /** Two arrows crossing — the standard shuffle symbol (matches PuzzleScene's). */
  private drawShuffleGlyph(g: Phaser.GameObjects.Graphics) {
    g.lineStyle(3, PALETTE.ink, 1);
    const head = (x: number, y: number, dx: number, dy: number) => {
      const a = Math.atan2(dy, dx);
      const s = 5;
      g.lineBetween(x, y, x - Math.cos(a - 0.5) * s, y - Math.sin(a - 0.5) * s);
      g.lineBetween(x, y, x - Math.cos(a + 0.5) * s, y - Math.sin(a + 0.5) * s);
    };
    g.lineBetween(-9, 7, 9, -7);
    head(9, -7, 2, -1.5);
    g.lineBetween(-9, -7, 9, 7);
    head(9, 7, 2, 1.5);
  }

  /** Fling the example tiles to fresh random spread-out positions (and bring any dragged
   *  off-screen back) — the same behaviour as the puzzle's shuffle (see scatterHomes), so the
   *  button visibly does its real job when the player tries it. */
  private shuffleTiles() {
    if (this.tileList.length === 0 || this.help) return;
    this.sfx.drop();
    const r = this.buttons[0]?.radius ?? 20;
    const homes = scatterHomes(this.tileList, {
      width: this.scale.width,
      top: LAYOUT_MARGIN + 4 + r * 2 + 12, // below the corner controls
      bottom: this.playBottom,
      scale: this.tileScale,
      margin: LAYOUT_MARGIN,
    });
    this.tileList.forEach((t, i) => t.setHome(homes[i]!.x, homes[i]!.y));
  }

  /** Open the link-type reference (the same panel the puzzle's ? button opens). Raised above
   *  the coach dim, and the coach is hidden while it's up so the two don't stack. */
  private openHelp() {
    if (this.help || this.finished) return;
    this.sfx.tap();
    this.coach?.setVisible(false);
    for (const b of this.buttons) b.setEnabled(false);
    const popup = new HelpPopup(this, {
      onClose: () => {
        this.help = null;
        if (!this.finished) this.coach?.setVisible(true);
        for (const b of this.buttons) b.setEnabled(true);
      },
    });
    popup.setDepth(150);
    this.help = popup;
  }

  /** A spotlight rect hugging the whole top-right control cluster. */
  private controlsRect(): Phaser.Geom.Rectangle | null {
    if (this.buttons.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of this.buttons) {
      minX = Math.min(minX, b.x - b.radius);
      minY = Math.min(minY, b.y - b.radius);
      maxX = Math.max(maxX, b.x + b.radius);
      maxY = Math.max(maxY, b.y + b.radius);
    }
    const pad = 8;
    return new Phaser.Geom.Rectangle(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
  }

  // ---------- STEP MACHINE ----------

  private showStep(i: number) {
    this.stepIndex = Phaser.Math.Clamp(i, 0, STEP_KEYS.length - 1);
    this.coach?.show(this.coachStepFor(STEP_KEYS[this.stepIndex]!), this.coachBottom());
  }

  /** Lowest y the coach bubble may occupy — just above the keyboard. */
  private coachBottom(): number {
    return this.scale.height - (this.keyboard?.reservedHeight() ?? 0) - 10;
  }

  private coachStepFor(key: StepKey): CoachStep {
    const total = STEP_KEYS.length;
    const index = STEP_KEYS.indexOf(key) + 1;
    const progress = { index, total };
    // SKIP on a guided step jumps to the free-play "solve" stage (dim off, board yours) rather
    // than straight to the wrap-up — so skipping still lets you actually try the puzzle. From
    // the solve stage itself, SKIP (skipEnd) bails to the wrap-up.
    const skip = { label: 'SKIP', onTap: () => this.jumpToPlay() };
    const skipEnd = { label: 'SKIP', onTap: () => this.skipToEnd() };
    const back = { label: 'BACK', onTap: () => this.showStep(this.stepIndex - 1) };
    const next = { label: 'NEXT', primary: true, onTap: () => this.showStep(this.stepIndex + 1) };

    switch (key) {
      case 'intro':
        return {
          text: 'Welcome to WordFish! Every puzzle is a little web of linked words. Some words are missing, and the links help tell you what they are.\n\nYou can click and drag these tutorial boxes around, or collapse them with the – button, to see behind them.',
          progress,
          minimizable: true,
          buttons: [skip, next],
        };
      case 'hidden':
        return {
          // First gameplay beat: what you're doing, and how the ?s tell you the length.
          text: 'Your job is to figure out the hidden words from the given information. Firstly, each ? is one letter, so this mystery word is five letters long.',
          target: () => this.tileRect('happy'),
          progress,
          minimizable: true,
          buttons: [skip, back, next],
        };
      case 'tile':
        return {
          text: 'These are "word tiles". You can drag them around to see how they connect, or to move them out of the way.',
          target: () => this.tileRect('sad'),
          progress,
          minimizable: true,
          buttons: [skip, back, next],
        };
      case 'antonym':
        return {
          text: "The chains show how two words relate. This one here is an antonym chain - the words connected by it are opposites. Tap any chain's label to see exactly what it's saying!",
          target: () => this.chainRect(this.antonymChain, 'sad', 'happy'),
          progress,
          minimizable: true,
          buttons: [skip, back, next],
        };
      case 'isa':
        return {
          text: "This chain has a direction; it means 'is a', and the arrow aims at the more specific word. So the hidden word is a kind of emotion.",
          target: () => this.chainRect(this.hypernymChain, 'emotion', 'happy'),
          progress,
          minimizable: true,
          buttons: [skip, back, next],
        };
      case 'controls':
        return {
          // Introduce the real in-game controls, and nudge them to open the link key.
          text: 'Up here are some useful buttons. BG hides the drifting background elements, ? lets you see every kind of link (there are 8 overall), the shuffle button rearranges your tiles, and the button in the top-left corner takes you back to the main menu.',
          target: () => this.controlsRect(),
          progress,
          minimizable: true,
          buttons: [skip, back, next],
        };
      case 'solve':
        return {
          // Letters/?s were covered back in 'hidden' — just a quick recap of the clues here.
          text: 'So, our hidden word is the opposite of SAD, a kind of EMOTION, and five letters long. Tap the tile and type your answer!',
          target: () => this.tileRect('happy'),
          progress,
          dim: false, // let them explore the whole board freely
          placement: 'top', // out of the middle, so the open board invites poking around
          minimizable: true, // and let them get the box fully out of the way while they guess
          buttons: [skipEnd, back], // no Next; solving the word advances you
        };
      case 'done':
      default:
        return {
          text: this.doneText(),
          progress,
          minimizable: true,
          buttons: [{ label: 'PLAY', primary: true, onTap: () => this.finish() }],
        };
    }
  }

  private doneText(): string {
    if (this.skipped) return "That's the overall idea; use the links to work out the missing words. Good luck!";
    if (this.lastSolvedWith && this.lastSolvedWith !== ANSWER) {
      return `Sneaky! ${this.lastSolvedWith} fits too!\n\nPuzzles are usually meant to have a single answer, but we left this in as an Easter Egg. Seems like you've mastered it; good luck out there!`;
    }
    return "Well done! The word was HAPPY. That's all there is to it - use the links to fill in every hidden word (sometimes there are multiple) and you win.\n\nGood luck!";
  }

  /** Spotlight rect around a tile (screen = world here, camera rests at 0 once slid in). */
  private tileRect(id: string): Phaser.Geom.Rectangle | null {
    const t = this.tiles.get(id);
    if (!t) return null;
    const hw = (t.boxWidth / 2) * this.tileScale + 8;
    const hh = (t.boxHeight / 2) * this.tileScale + 8;
    return new Phaser.Geom.Rectangle(t.x - hw, t.y - hh, hw * 2, hh * 2);
  }

  /** Spotlight rect hugging the chain's label chip. Falls back to the tiles' midpoint on the
   *  odd frame the chip is faded (e.g. before the chain has settled). */
  private chainRect(chain: Chain | null, a: string, b: string): Phaser.Geom.Rectangle | null {
    const bounds = chain?.chipBounds();
    if (bounds) {
      return new Phaser.Geom.Rectangle(
        bounds.x - bounds.w / 2 - 8,
        bounds.y - bounds.h / 2 - 8,
        bounds.w + 16,
        bounds.h + 16
      );
    }
    const ta = this.tiles.get(a);
    const tb = this.tiles.get(b);
    if (!ta || !tb) return null;
    const cx = (ta.x + tb.x) / 2;
    const cy = (ta.y + tb.y) / 2;
    return new Phaser.Geom.Rectangle(cx - 70, cy - 24, 140, 48);
  }

  /** Jump straight to the free-play "solve" stage — what SKIP does from a guided step, so
   *  skipping the explanations still drops you into an unblocked board to try the puzzle. */
  private jumpToPlay() {
    this.showStep(STEP_KEYS.indexOf('solve'));
  }

  /** Skip ahead to the wrap-up instead of stepping through the rest. */
  private skipToEnd() {
    this.skipped = true;
    this.keyboard?.setMinimized(true);
    this.clearFocus();
    this.showStep(STEP_KEYS.indexOf('done'));
  }

  private finish() {
    if (this.transitioning || isTransitioning()) return;
    this.transitioning = true;
    this.finished = true;
    this.sfx.tap();
    this.coach?.setVisible(false); // drop the dim instantly so it can't smear on the way out
    transitionToPage(this, 'MenuScene', {}, 'right', 0);
  }

  // ---------- INPUT (mirrors PuzzleScene) ----------

  private routeKey(key: string) {
    if (this.finished) return;
    if (!this.focused && (/^[a-zA-Z]$/.test(key) || key === 'Backspace')) {
      const target = this.tileList.find((t) => t.editable);
      if (!target) return;
      this.focusTile(target, target.boxWidth);
    }
    this.focused?.pressKey(key);
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
    this.input.on(
      'pointerdown',
      (_pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
        if (!over || over.length === 0) this.clearFocus();
      }
    );
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key;
      const isLetter = /^[a-zA-Z]$/.test(key);
      if (key === 'Backspace') event.preventDefault();
      if (isLetter || key === 'Backspace') this.keyboard?.flashKey(key);
      this.routeKey(key);
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
    this.clearFocus();
  }

  endTileDrag(_tile: WordTile) {}

  /** Drag bounds: keep a dragged tile fully on canvas and above the keyboard / URL-bar strip
   *  (same clamps the layout uses), so it can't be lost off an edge. Mirrors PuzzleScene. */
  clampTilePosition(tile: WordTile, x: number, y: number): { x: number; y: number } {
    return { x: this.clampX(tile, x), y: this.clampY(tile, y, this.playBottom) };
  }

  playFx(name: TileFxName) {
    this.sfx[name]();
  }

  tileSolved(tile: WordTile) {
    if (this.finished) return;
    this.lastSolvedWith = tile.solvedWith;
    this.sfx.win();
    this.cameras.main.flash(220, 255, 255, 255);
    this.keyboard?.setMinimized(true);
    this.clearFocus();
    // Jump to the celebratory final step (works even if they solved it early).
    this.showStep(STEP_KEYS.indexOf('done'));
  }

  override update(time: number, delta: number) {
    for (const tile of this.tileList) tile.tick(delta);
    for (const chain of this.chains) chain.update(time);
    // Keep the spotlight glued to its target as tiles are dragged / chains drift.
    this.coach?.refreshSpotlight();
  }
}
