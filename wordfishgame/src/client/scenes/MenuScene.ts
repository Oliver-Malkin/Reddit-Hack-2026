import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import { MenuButton } from '../puzzle/MenuButton';
import { createDecorToggle } from '../puzzle/decorToggle';
import { SoundFx } from '../puzzle/SoundFx';
import { buildTitle, pickTitleStyle } from '../puzzle/titleStyles';
import type { TitleStyle } from '../puzzle/titleStyles';
import type { Difficulty, Puzzle } from '../puzzle/types';
import { openPuzzleEditor, showPuzzleEditor } from '../puzzle/editor/PuzzleEditor';
import { getBootPuzzle } from '../puzzle/remote';
import type { CustomPuzzle } from '../puzzle/remote';
import type { BackgroundScene } from './BackgroundScene';
import { slideCameraIn, transitionToPage, jumpToPage, isTransitioning } from './pageTransition';
import type { PageEnterData } from './pageTransition';

const MARGIN = 16;
/** The three small accent dots under the tagline — a quiet Memphis divider. */
const ACCENT_DOTS = [PALETTE.pink, PALETTE.yellow, PALETTE.cyan];

/**
 * The home / splash screen — the first thing the player sees, sitting on top of the shared
 * BackgroundScene so the drifting Memphis field is continuous into the game and tutorial.
 *
 * Choosing a difficulty (or the tutorial) hands off via a shared page transition: the menu
 * camera pans this page off one edge while the destination pans in from the other, and the
 * background pans the same way but less (a more distant layer). Pages are kept alive with
 * sleep/wake, so returning here just wakes and slides the menu back in (see onWake).
 *
 * The layout is rebuilt from scratch on every resize (cheap — a handful of graphics/text),
 * so it re-fits cleanly on phone portrait and desktop landscape alike.
 */
export class MenuScene extends Phaser.Scene {
  private root!: Phaser.GameObjects.Container;
  private buttons: MenuButton[] = [];
  private sfx = new SoundFx();
  private transitioning = false;
  // References the first-load entrance animation springs in (set by render()).
  private introTitle: (Phaser.GameObjects.Text | Phaser.GameObjects.Container)[] = [];
  private introTagline: (Phaser.GameObjects.Text | Phaser.GameObjects.Graphics)[] = [];
  // The title treatment for this appearance — re-rolled on first load and each return to
  // the menu, but held stable across resizes so a window drag doesn't reshuffle it.
  private titleStyle: TitleStyle = pickTitleStyle();
  // The editor overlay is open — the menu underneath is inert until it closes.
  private editorOpen = false;
  // When this post is a user-created puzzle, the menu becomes that puzzle's intro splash
  // (title + author + Play) instead of the daily menu. Resolved once at boot.
  private customPuzzle: CustomPuzzle | null = getBootPuzzle();

  constructor() {
    super('MenuScene');
  }

  create() {
    this.root = this.add.container(0, 0);
    this.render();
    this.playEntrance();

    this.scale.on('resize', () => {
      // Never rebuild mid-sweep — that would recreate the UI we're animating away.
      if (this.transitioning) return;
      this.render();
    });

    // Returning from a page: reset, rebuild for the current size, and slide back in.
    // No enterFrom means a page JUMP (editor preview round-trips) — snap into place
    // instead, since those swaps happen behind the editor overlay and mustn't move.
    this.events.on(Phaser.Scenes.Events.WAKE, (_sys: unknown, data: Partial<PageEnterData>) => {
      this.transitioning = false;
      this.titleStyle = pickTitleStyle(); // a fresh title each time you come back
      this.render();
      if (data?.enterFrom) slideCameraIn(this, data.enterFrom);
      else this.cameras.main.setScroll(0, 0);
      // Coming back from a preview: bring the (still-alive) editor overlay back on top,
      // its form exactly as it was left.
      if ((data as { reopenEditor?: boolean })?.reopenEditor) {
        this.editorOpen = true;
        showPuzzleEditor();
      }
    });
  }

  /** Build (or rebuild) the whole menu sized to the current canvas. */
  private render() {
    // A user-created puzzle post shows that puzzle's intro splash instead of the daily menu.
    if (this.customPuzzle) {
      this.renderCustomIntro(this.customPuzzle);
      return;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    this.root.removeAll(true);
    this.buttons = [];

    // ---- Title block, pinned near the top ----
    const titleTop = Phaser.Math.Clamp(H * 0.13, 52, 132);
    const titleSize = Phaser.Math.Clamp(Math.round(W * 0.13), 44, 96);
    // One of a rotating set of Memphis treatments (see titleStyles), re-rolled per menu
    // appearance so the splash feels a little different every visit.
    const title = buildTitle(this, cx, titleTop, titleSize, this.titleStyle);
    this.root.add(title);
    // Sit the tagline below the title's actual bottom — styles with a backing card (cutout)
    // extend past the plain cap-height, so a fixed titleSize/2 gap let the card cover it.
    const titleHalfH = (title.getData('halfHeight') as number) ?? titleSize / 2;
    let y = titleTop + titleHalfH + 12;

    const tagline = this.text(cx, y, 'A DAILY WORD PUZZLE', Phaser.Math.Clamp(Math.round(W * 0.026), 12, 17), '800', '#2b2d6e');
    tagline.setLetterSpacing(3);
    y += tagline.height + 12;

    const dots = this.add.graphics();
    ACCENT_DOTS.forEach((c, i) => {
      dots.fillStyle(c, 1);
      dots.fillCircle(cx + (i - 1) * 18, y, 4);
    });
    this.root.add(dots);

    // ---- Lower group (daily header + difficulty + tutorial), vertically centred in the
    // space beneath the title so it stays balanced on tall and short canvases alike. ----
    const btnW = Phaser.Math.Clamp(Math.round(W * 0.74), 220, 330);
    const btnH = Phaser.Math.Clamp(Math.round(H * 0.09), 56, 72);
    const tutH = Math.round(btnH * 0.78);
    const gapBtn = 16;
    const gapSection = 20;

    const dateStr = this.todayLabel();
    const headerH = 18;
    const dateH = 16;
    const groupH =
      headerH + 4 + dateH + gapSection + btnH + gapBtn + btnH + gapSection + tutH + gapBtn + tutH;

    const groupTop = y + 16 + Math.max(0, (H - (y + 16) - MARGIN - groupH) / 2);
    let gy = groupTop;

    const header = this.text(cx, gy + headerH / 2, "TODAY'S PUZZLE", 14, '900', '#1c1c1c');
    header.setLetterSpacing(2);
    gy += headerH + 4;
    this.text(cx, gy + dateH / 2, dateStr, 13, '700', '#6a6a6a');
    gy += dateH + gapSection;

    const easy = new MenuButton(this, cx, gy + btnH / 2, {
      width: btnW,
      height: btnH,
      label: 'EASY',
      fill: PALETTE.cyan,
      textColor: '#1c1c1c',
      pips: { filled: 1, total: 3, color: PALETTE.ink },
      onTap: () => this.startPuzzle('easy'),
    });
    gy += btnH + gapBtn;

    const hard = new MenuButton(this, cx, gy + btnH / 2, {
      width: btnW,
      height: btnH,
      label: 'HARD',
      fill: PALETTE.red,
      textColor: '#ffffff',
      pips: { filled: 3, total: 3, color: 0xffffff },
      onTap: () => this.startPuzzle('hard'),
    });
    gy += btnH + gapSection;

    const tutorial = new MenuButton(this, cx, gy + tutH / 2, {
      width: btnW,
      height: tutH,
      label: 'HOW TO PLAY',
      fill: 0xffffff,
      textColor: '#1c1c1c',
      onTap: () => this.openTutorial(),
    });
    gy += tutH + gapBtn;

    // Secondary action: build and publish your own puzzle. Purple keeps it distinct from
    // the daily buttons while staying in the Memphis palette.
    const create = new MenuButton(this, cx, gy + tutH / 2, {
      width: btnW,
      height: tutH,
      label: 'CREATE A PUZZLE',
      fill: PALETTE.purple,
      textColor: '#ffffff',
      onTap: () => this.openEditor(),
    });

    this.buttons = [easy, hard, tutorial, create];
    this.root.add(this.buttons);

    // Clean-mode toggle in the top-right corner — shared with the puzzle (see decorToggle).
    const r = 20;
    const decor = createDecorToggle(this, () => this.sfx.tap());
    decor.setPosition(W - (16 + 4 + r), 16 + 4 + r);
    this.root.add(decor);

    this.introTitle = [title];
    this.introTagline = [tagline, dots];
  }

  /**
   * The intro splash for a user-created puzzle post: the WordFish brand, a "COMMUNITY PUZZLE"
   * tag, the puzzle's title, its author (u/name), then PLAY straight into the board plus a
   * HOW TO PLAY for first-timers. No daily menu — this post IS one puzzle.
   */
  private renderCustomIntro(custom: CustomPuzzle) {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    this.root.removeAll(true);
    this.buttons = [];

    // Brand title, a touch smaller than the daily menu's so the puzzle title has room.
    const titleTop = Phaser.Math.Clamp(H * 0.12, 48, 118);
    const titleSize = Phaser.Math.Clamp(Math.round(W * 0.11), 40, 84);
    const title = buildTitle(this, cx, titleTop, titleSize, this.titleStyle);
    this.root.add(title);
    const titleHalfH = (title.getData('halfHeight') as number) ?? titleSize / 2;
    let y = titleTop + titleHalfH + 14;

    const tag = this.text(cx, y, 'COMMUNITY PUZZLE', Phaser.Math.Clamp(Math.round(W * 0.026), 12, 16), '900', '#ff2f8f');
    tag.setLetterSpacing(3);
    y += tag.height + 10;

    const dots = this.add.graphics();
    ACCENT_DOTS.forEach((c, i) => {
      dots.fillStyle(c, 1);
      dots.fillCircle(cx + (i - 1) * 18, y, 4);
    });
    this.root.add(dots);
    y += 18;

    // ---- Lower group: puzzle title + author + Play + How to play, vertically centred. ----
    const btnW = Phaser.Math.Clamp(Math.round(W * 0.74), 220, 330);
    const btnH = Phaser.Math.Clamp(Math.round(H * 0.09), 56, 72);
    const tutH = Math.round(btnH * 0.78);
    const gapBtn = 16;

    // Fit the (untrusted-length) title: shrink for long titles, wrap as a last resort.
    const rawTitle = custom.title.toUpperCase();
    const titleFont = Phaser.Math.Clamp(Math.round(W * 0.085), 22, rawTitle.length > 16 ? 30 : 44);
    const puzzleTitle = this.add.text(cx, 0, rawTitle, {
      fontFamily: UI_FONT,
      fontSize: `${titleFont}px`,
      fontStyle: '900',
      color: '#1c1c1c',
      align: 'center',
      wordWrap: { width: W - 48, useAdvancedWrap: true },
    });
    puzzleTitle.setOrigin(0.5);

    const author = this.text(cx, 0, `by u/${custom.author}`, Phaser.Math.Clamp(Math.round(W * 0.03), 13, 18), '700', '#2b2d6e');

    const groupH = puzzleTitle.height + 10 + author.height + 24 + btnH + gapBtn + tutH;
    const groupTop = y + Math.max(0, (H - y - MARGIN - groupH) / 2);
    let gy = groupTop;

    puzzleTitle.setY(gy + puzzleTitle.height / 2);
    this.root.add(puzzleTitle);
    gy += puzzleTitle.height + 10;
    author.setY(gy + author.height / 2);
    gy += author.height + 24;

    const play = new MenuButton(this, cx, gy + btnH / 2, {
      width: btnW,
      height: btnH,
      label: '▶ PLAY',
      fill: PALETTE.cyan,
      textColor: '#1c1c1c',
      onTap: () => this.startCustomPuzzle(custom.puzzle),
    });
    gy += btnH + gapBtn;

    const tutorial = new MenuButton(this, cx, gy + tutH / 2, {
      width: btnW,
      height: tutH,
      label: 'HOW TO PLAY',
      fill: 0xffffff,
      textColor: '#1c1c1c',
      onTap: () => this.openTutorial(),
    });

    this.buttons = [play, tutorial];
    this.root.add(this.buttons);

    // Clean-mode toggle, shared with the puzzle, in the top-right corner.
    const r = 20;
    const decor = createDecorToggle(this, () => this.sfx.tap());
    decor.setPosition(W - (16 + 4 + r), 16 + 4 + r);
    this.root.add(decor);

    this.introTitle = [title];
    this.introTagline = [tag, dots, puzzleTitle, author];
  }

  /** Springy first-load reveal: title drops in, buttons pop up staggered. Only on boot —
   *  returning from a page slides the whole thing in instead (see onWake). */
  private playEntrance() {
    for (const t of this.introTitle) {
      const finalY = t.y;
      t.setAlpha(0).setY(finalY - 34);
      this.tweens.add({ targets: t, y: finalY, alpha: 1, duration: 520, ease: 'Back.easeOut' });
    }
    for (const o of this.introTagline) {
      o.setAlpha(0);
      this.tweens.add({ targets: o, alpha: 1, duration: 400, delay: 260 });
    }
    this.buttons.forEach((b, i) => {
      b.setScale(0.6).setAlpha(0);
      this.tweens.add({
        targets: b,
        scale: 1,
        alpha: 1,
        duration: 460,
        delay: 300 + i * 90,
        ease: 'Back.easeOut',
      });
    });
  }

  private startPuzzle(difficulty: Difficulty) {
    this.openPage('PuzzleScene', { difficulty }, () => this.sfx.drop());
  }

  private openTutorial() {
    this.openPage('TutorialScene', {}, () => this.sfx.tap());
  }

  /** Open the DOM puzzle-creator overlay on top of the (inert) menu. */
  private openEditor() {
    if (this.editorOpen || this.transitioning || isTransitioning()) return;
    this.editorOpen = true;
    this.sfx.tap();
    for (const b of this.buttons) b.setEnabled(false);
    openPuzzleEditor({
      onClose: () => {
        this.editorOpen = false;
        for (const b of this.buttons) b.setEnabled(true);
      },
      onPreview: (puzzle) => {
        // Preview the freshly built puzzle in the real board. The editor stays alive so the
        // board's back arrow can return to this exact form — editorOpen stays true. The swap
        // is a JUMP, not a slide: it happens under the still-covering overlay, which then
        // fades out to reveal the board already in place (no menu flash, no visible sweep).
        if (this.transitioning || isTransitioning()) return;
        this.sfx.drop();
        const bg = this.scene.get('BackgroundScene') as BackgroundScene;
        jumpToPage(this, 'PuzzleScene', { puzzle, preview: true }, bg.parallaxOffset());
      },
    });
  }

  /** Play this post's custom puzzle from its intro splash, handing the board the puzzle's
   *  title/author/url so its win screen can build a proper "I solved u/x's puzzle" share. */
  private startCustomPuzzle(puzzle: Puzzle) {
    const c = this.customPuzzle;
    const data: Record<string, unknown> = { puzzle };
    if (c) data.customMeta = { title: c.title, author: c.author, url: c.url };
    this.openPage('PuzzleScene', data, () => this.sfx.drop());
  }

  /** Hand off to another page (puzzle / tutorial): sweep this menu off to the left while the
   *  destination slides in from the right and the background parallax leans the same way. */
  private openPage(key: string, data: Record<string, unknown>, sound: () => void) {
    if (this.transitioning || isTransitioning()) return;
    this.transitioning = true;
    sound();
    for (const b of this.buttons) b.setEnabled(false);
    const bg = this.scene.get('BackgroundScene') as BackgroundScene;
    transitionToPage(this, key, data, 'left', bg.parallaxOffset());
  }

  /** e.g. "THURSDAY 9 JULY" — reinforces that each button is a fresh daily level. */
  private todayLabel(): string {
    try {
      return new Date()
        .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
        .toUpperCase();
    } catch {
      return 'TODAY';
    }
  }

  /** Add a centred text to `root` in the shared UI font. */
  private text(x: number, y: number, str: string, size: number, weight: string, color: string) {
    const t = this.add.text(x, y, str, {
      fontFamily: UI_FONT,
      fontSize: `${size}px`,
      fontStyle: weight,
      color,
    });
    t.setOrigin(0.5);
    this.root.add(t);
    return t;
  }
}
