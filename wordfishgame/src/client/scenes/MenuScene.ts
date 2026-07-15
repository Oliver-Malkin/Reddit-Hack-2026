import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import { MenuButton } from '../puzzle/MenuButton';
import { createDecorToggle } from '../puzzle/decorToggle';
import { SoundFx } from '../puzzle/SoundFx';
import { buildTitle, pickTitleStyle } from '../puzzle/titleStyles';
import type { TitleStyle } from '../puzzle/titleStyles';
import type { Difficulty, Puzzle } from '../puzzle/types';
import { openPuzzleEditor, showPuzzleEditor } from '../puzzle/editor/PuzzleEditor';
import {
  getBootPuzzle,
  getBootDailyDay,
  getBootIsOwnPuzzle,
  deleteOwnPuzzle,
  navigateToPost,
} from '../puzzle/remote';
import type { CustomPuzzle } from '../puzzle/remote';
import { ConfirmPopup } from '../puzzle/ConfirmPopup';
import { utcDayLabel } from '../../shared/daily';
import type { BackgroundScene } from './BackgroundScene';
import { slideCameraIn, transitionToPage, jumpToPage, isTransitioning } from './pageTransition';
import type { PageEnterData } from './pageTransition';
import type { UserStreak } from '../../shared/api';

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

  // The player's daily-solve streak, fetched once from the server (see fetchStreak) and cached
  // so every later render — resize, return to menu — draws from this instead of refetching.
  // null means "not resolved yet" (still loading, or logged out / fetch failed): the badge slot
  // stays empty. 0 means resolved-but-no-active-streak; >0 is the run length.
  private streak: number | null = null;
  private streakRequested = false;
  // The streak badge lives in a fixed-height slot so the async value landing never shifts the
  // menu below it. These track where to (re)draw it, and the current badge object for in-place
  // replacement when the fetch resolves after the first render.
  private streakCenter = { x: 0, y: 0 };
  private streakBadge: Phaser.GameObjects.Container | null = null;

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
      // Coming back from a preview: bring the (still-alive) editor overlay back on top, its
      // form exactly as it was left — the menu underneath stays inert (render() disables the
      // buttons while editorOpen). Any other wake ends the editor journey, so the flag is
      // cleared; a stale true would wedge every menu button shut for good.
      this.editorOpen =
        Boolean((data as { reopenEditor?: boolean })?.reopenEditor) && showPuzzleEditor();
      this.titleStyle = pickTitleStyle(); // a fresh title each time you come back
      this.render();
      if (data?.enterFrom) slideCameraIn(this, data.enterFrom);
      else this.cameras.main.setScroll(0, 0);
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
    y += 24; // space between the accent dots and the streak badge

    // ---- Streak badge ----
    // A fixed-height slot so the (async) streak value landing later never nudges the buttons
    // below. drawStreakBadge fills it from the cached value; fetchStreak kicks the one-time
    // load and patches the badge in place when it resolves.
    const streakSlotH = 30;
    this.streakCenter = { x: cx, y: y + streakSlotH / 2 };
    this.streakBadge = null; // the previous one was destroyed by root.removeAll above
    this.drawStreakBadge();
    this.fetchStreak();
    y += streakSlotH + 14;

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
    // A rebuild while the editor overlay is up (window resize / reddit's fullscreen toggle)
    // must not resurrect live buttons beneath it — openEditor disabled the previous set.
    if (this.editorOpen) for (const b of this.buttons) b.setEnabled(false);

    // Clean-mode toggle in the top-right corner — shared with the puzzle (see decorToggle).
    const r = 20;
    const decor = createDecorToggle(this, () => this.sfx.tap());
    decor.setPosition(W - (16 + 4 + r), 16 + 4 + r);
    this.root.add(decor);

    this.introTitle = [title];
    this.introTagline = [tagline, dots];
  }

  /**
   * Draw the streak badge into its reserved slot from the cached `this.streak`, replacing any
   * badge already there. A Memphis pill (offset shadow + thick ink border) that matches the
   * menu buttons: a warm yellow "N-DAY STREAK" once the run is going, or a quiet white nudge to
   * start one. While the value is still loading (streak === null) the slot is left empty.
   *
   * `animate` springs the badge in — used when the fetch resolves after the first render, so it
   * pops in rather than appearing abruptly; a plain resize rebuild draws it instantly.
   */
  private drawStreakBadge(animate = false) {
    this.streakBadge?.destroy();
    this.streakBadge = null;
    if (this.streak === null) return;

    const { x, y } = this.streakCenter;
    const active = this.streak > 0;
    // Emoji is deliberately avoided — it renders on-canvas only where a colour-emoji font
    // happens to be installed, which isn't guaranteed across Reddit's webviews. A small drawn
    // flame carries the "streak" idea reliably instead (see below); the copy stays plain text.
    const label = active
      ? `${this.streak}-DAY STREAK`
      : 'START A STREAK TODAY';

    const badge = this.add.container(x, y);
    const text = this.add.text(0, 0, label, {
      fontFamily: UI_FONT,
      fontSize: '14px',
      fontStyle: '900',
      color: active ? '#1c1c1c' : '#8a8a8a',
    });
    text.setOrigin(0.5).setLetterSpacing(1);

    // A little Memphis flame sits to the left of the text when the streak is live — a drawn
    // glyph (two overlapping teardrops) so it always renders, unlike an emoji.
    const flameW = active ? 16 : 0;
    const flameGap = active ? 6 : 0;
    const padX = 16;
    const padY = 7;
    const contentW = Math.round(text.width) + flameW + flameGap;
    const w = contentW + padX * 2;
    const h = Math.round(text.height) + padY * 2;
    const rad = h / 2;

    const pill = this.add.graphics();
    pill.fillStyle(PALETTE.ink, 0.16);
    pill.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, rad); // offset shadow
    pill.fillStyle(active ? PALETTE.yellow : 0xffffff, 1);
    pill.fillRoundedRect(-w / 2, -h / 2, w, h, rad);
    pill.lineStyle(3, PALETTE.ink, 1);
    pill.strokeRoundedRect(-w / 2, -h / 2, w, h, rad);

    // Left-align the flame + text as a group inside the pill.
    const contentLeft = -contentW / 2;
    badge.add(pill);
    if (active) {
      const flame = this.drawFlame(contentLeft + flameW / 2, 0);
      badge.add(flame);
      text.setPosition(contentLeft + flameW + flameGap + Math.round(text.width) / 2, 0);
    } else {
      text.setPosition(0, 0);
    }
    badge.add(text);
    this.root.add(badge);
    this.streakBadge = badge;

    if (animate) {
      badge.setScale(0.6).setAlpha(0);
      this.tweens.add({ targets: badge, scale: 1, alpha: 1, duration: 360, ease: 'Back.easeOut' });
    }
  }

  /** A small Memphis flame (red teardrop with a warm inner highlight), drawn from primitives
   *  so it renders everywhere an emoji might not. Centred on (x, y) in its parent container. */
  private drawFlame(x: number, y: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.setPosition(x, y);
    g.fillStyle(PALETTE.red, 1);
    g.fillCircle(0, 3, 5);
    g.fillTriangle(-5, 3, 5, 3, 0, -9);
    g.fillStyle(0xfff2c4, 1); // cream inner flame for a hint of depth on the yellow pill
    g.fillCircle(0, 4, 2.4);
    g.fillTriangle(-2.4, 4, 2.4, 4, 0, -2);
    return g;
  }

  /**
   * Fetch the player's streak once and cache it. The `streakRequested` guard makes every later
   * render (resize / return to menu) a no-op, so the menu draws from the cached value rather
   * than hitting the server each time. When the value lands, patch the badge in place — but
   * only if the daily menu is still the live page (not navigated away, asleep, or turned into a
   * community-puzzle intro, none of which have a streak slot).
   */
  private fetchStreak() {
    if (this.streakRequested) return;
    this.streakRequested = true;
    void (async () => {
      try {
        const response = await fetch('/api/fetch_streak');
        if (!response.ok) return; // e.g. logged out (no userId) — leave the badge hidden
        const data = (await response.json()) as UserStreak;
        this.streak = data.streak;
      } catch (error) {
        console.error('Failed to fetch streak', error);
        return;
      }
      if (this.customPuzzle || !this.scene.isActive()) return;
      this.drawStreakBadge(true);
    })();
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

    // Only the puzzle's own creator sees this (server-checked — see puzzle/remote's
    // getBootIsOwnPuzzle), tucked below the main buttons as a small, deliberately
    // low-key link so it's never mistaken for part of the normal play flow.
    const showDelete = getBootIsOwnPuzzle();
    const deleteGap = showDelete ? 16 : 0;
    const deleteSize = Phaser.Math.Clamp(Math.round(W * 0.024), 11, 13);

    const groupH =
      puzzleTitle.height + 10 + author.height + 24 + btnH + gapBtn + tutH + deleteGap + deleteSize;
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
    gy += tutH;

    this.buttons = [play, tutorial];
    this.root.add(this.buttons);
    // Same guard as render(): no live buttons under an open editor overlay.
    if (this.editorOpen) for (const b of this.buttons) b.setEnabled(false);

    if (showDelete) {
      gy += deleteGap;
      const deleteLink = this.text(cx, gy + deleteSize / 2, 'DELETE MY PUZZLE', deleteSize, '900', '#c23b3b');
      deleteLink.setLetterSpacing(1);
      deleteLink.setInteractive({ useHandCursor: true });
      deleteLink.on('pointerdown', () => this.confirmDeletePuzzle());
    }

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
        // Returns whether the jump really happened — the editor only fades itself out on
        // success (fading over an unchanged page would strand the player outside their form).
        if (this.transitioning || isTransitioning()) return false;
        this.sfx.drop();
        const bg = this.scene.get('BackgroundScene') as BackgroundScene;
        return jumpToPage(this, 'PuzzleScene', { puzzle, preview: true }, bg.parallaxOffset());
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

  /** "Delete my puzzle": confirm first (irreversible — it's a real Reddit post going away),
   *  then hand off to the server (which re-checks ownership) and leave for the subreddit,
   *  since this post won't exist to come back to. */
  private confirmDeletePuzzle() {
    if (this.editorOpen || this.transitioning || isTransitioning()) return;
    this.sfx.tap();
    new ConfirmPopup(this, {
      message: "Delete this puzzle? It removes the Reddit post for good — this can't be undone.",
      confirmLabel: 'DELETE',
      onConfirm: () => void this.performDeletePuzzle(),
      onClose: () => {},
    });
  }

  private async performDeletePuzzle() {
    const result = await deleteOwnPuzzle();
    if (result.ok) {
      await navigateToPost(result.subredditUrl);
      return;
    }
    new ConfirmPopup(this, {
      message: result.message,
      confirmLabel: 'OK',
      onConfirm: () => {},
      onClose: () => {},
    });
  }

  /** Hand off to another page (puzzle / tutorial): sweep this menu off to the left while the
   *  destination slides in from the right and the background parallax leans the same way. */
  private openPage(key: string, data: Record<string, unknown>, sound: () => void) {
    // editorOpen: the menu is inert beneath the editor overlay — no navigation from under it.
    if (this.editorOpen || this.transitioning || isTransitioning()) return;
    this.transitioning = true;
    sound();
    for (const b of this.buttons) b.setEnabled(false);
    const bg = this.scene.get('BackgroundScene') as BackgroundScene;
    transitionToPage(this, key, data, 'left', bg.parallaxOffset());
  }

  /** e.g. "THURSDAY 9 JULY" — reinforces that each button is a fresh daily level. On a daily
   *  post this is the post's FROZEN day (so it names the puzzle actually on offer, and matches
   *  a historical post rather than always saying today); local preview falls back to now. */
  private todayLabel(): string {
    const day = getBootDailyDay();
    if (day != null) return utcDayLabel(day);
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
