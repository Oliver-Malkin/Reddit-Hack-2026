import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';

/** One styled piece of an example line: a bold WORD, a muted connective/symbol, or a
 *  word whose individual letters are highlighted per `mask` (used to show letter subsets). */
type ExampleSeg =
  | { kind: 'word'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'sub'; text: string; mask: boolean[] };

type KeyRow = { tex: string; name: string; meaning: string; example: ExampleSeg[] };

/**
 * The lookup key: one row per link type, each with the exact chain texture the player
 * sees in play (baked by Chain.bakeTextures — must run first), a short meaning, and a
 * distinct worked EXAMPLE that carries most of the explanation. Kept concise on purpose;
 * the main-menu tutorial will go deeper.
 */
const KEY_ROWS: KeyRow[] = [
  {
    tex: 'chain-eq',
    name: 'Synonym',
    meaning: 'Means the same thing',
    example: [{ kind: 'word', text: 'BIG' }, { kind: 'op', text: '=' }, { kind: 'word', text: 'LARGE' }],
  },
  {
    tex: 'chain-neq',
    name: 'Antonym',
    meaning: 'Means the opposite',
    example: [{ kind: 'word', text: 'HOT' }, { kind: 'op', text: '≠' }, { kind: 'word', text: 'COLD' }],
  },
  {
    tex: 'chain-chevron-yellow',
    name: 'Is a',
    meaning: 'One is a kind of the other',
    example: [{ kind: 'word', text: 'ROBIN' }, { kind: 'op', text: 'is a' }, { kind: 'word', text: 'BIRD' }],
  },
  {
    tex: 'chain-mix',
    name: 'Anagram',
    meaning: 'The same letters, rearranged',
    example: [{ kind: 'word', text: 'LISTEN' }, { kind: 'op', text: '⟳' }, { kind: 'word', text: 'SILENT' }],
  },
  {
    tex: 'chain-meronym',
    name: 'Part of',
    meaning: 'One is a part of the other',
    example: [{ kind: 'word', text: 'PETAL' }, { kind: 'op', text: 'part of' }, { kind: 'word', text: 'FLOWER' }],
  },
  {
    tex: 'chain-into',
    name: 'Letters in',
    meaning: "One's letters hide inside the other",
    // The letters of CLAM, highlighted where they appear inside ACCLAIM.
    example: [
      { kind: 'word', text: 'CLAM' },
      { kind: 'op', text: '▸' },
      { kind: 'sub', text: 'ACCLAIM', mask: [false, true, false, true, true, false, true] },
    ],
  },
  {
    tex: 'chain-seq',
    name: 'Becomes',
    meaning: 'One turns into the other, given the right conditions',
    example: [{ kind: 'word', text: 'TADPOLE' }, { kind: 'op', text: 'becomes' }, { kind: 'word', text: 'FROG' }],
  },
  {
    tex: 'chain-rhyme',
    name: 'Rhymes',
    meaning: 'The words sound alike',
    example: [{ kind: 'word', text: 'MOON' }, { kind: 'op', text: '~' }, { kind: 'word', text: 'SPOON' }],
  },
];

const INTRO =
  'Words are linked together by chains, and each chain shows how two words relate. Some words are hidden (shown as ???) — work them out from the words you know and the links between them. Fill in every hidden word to win.';

const MARGIN = 16; // min gap from the panel to the canvas edge
const PAD = 22; // panel interior padding
const MAX_W = 680;

export type HelpPopupOptions = {
  /** Called after the dismiss animation completes. */
  onClose: () => void;
};

/**
 * A modal "how to play" panel: dims the whole canvas, then floats a rounded white card
 * (larger than the win popup) holding the intro and the link-type key. Fully responsive
 * — it re-fits to the canvas on every resize, and the content is uniformly scaled to
 * fit the card's interior so nothing is ever clipped or scrolled, on phone or desktop.
 * Tap the dim area or the × to close.
 */
export class HelpPopup extends Phaser.GameObjects.Container {
  private onClose: () => void;
  private overlay: Phaser.GameObjects.Graphics;
  private overlayHit: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Container;
  private resizeHandler: () => void;

  constructor(scene: Phaser.Scene, options: HelpPopupOptions) {
    super(scene, 0, 0);
    this.onClose = options.onClose;
    scene.add.existing(this);
    this.setDepth(100);

    this.overlay = scene.add.graphics();
    this.add(this.overlay);
    this.overlayHit = scene.add.container(0, 0);
    this.overlayHit.on('pointerdown', () => this.dismiss());
    this.add(this.overlayHit);
    this.panel = scene.add.container(0, 0);
    this.add(this.panel);

    this.build(true);

    // Re-fit to the canvas whenever it changes size (orientation, webview resize).
    this.resizeHandler = () => this.build(false);
    scene.scale.on('resize', this.resizeHandler);
    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      scene.scale.off('resize', this.resizeHandler);
    });
  }

  /** (Re)build the overlay + card for the current canvas size. Springs in when `first`. */
  private build(first: boolean) {
    const scene = this.scene;
    const W = scene.scale.width;
    const H = scene.scale.height;

    // Full-canvas dim + a matching hit zone that closes on tap.
    this.overlay.clear();
    this.overlay.fillStyle(PALETTE.ink, 0.55);
    this.overlay.fillRect(0, 0, W, H);
    this.overlayHit.setSize(W, H);
    this.overlayHit.setPosition(W / 2, H / 2);
    this.overlayHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, W, H),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });

    const outerMaxW = W - MARGIN * 2;
    const outerMaxH = H - MARGIN * 2;
    this.panel.removeAll(true);
    this.panel.setPosition(W / 2, H / 2);

    // Build the content FIRST, then size the card to hug it — so the box grows and
    // shrinks with the text (up to two columns when there's room) instead of leaving
    // wide empty margins. buildContent picks its own width within what the canvas allows.
    const maxInteriorW = Math.min(MAX_W, outerMaxW) - PAD * 2;
    const { content, contentW, naturalH } = this.buildContent(maxInteriorW);
    const cardW = Math.min(MAX_W, outerMaxW, contentW + PAD * 2);
    const cardH = Math.min(outerMaxH, naturalH + PAD * 2);
    const interiorH = cardH - PAD * 2;
    // The card already hugs contentW, so width fits; only height may need scaling down.
    const fit = Math.min(1, interiorH / naturalH);

    // Card: offset shadow, white fill, thick ink border, Memphis corner accents.
    const g = scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.2);
    g.fillRoundedRect(-cardW / 2 + 8, -cardH / 2 + 10, cardW, cardH, 20);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
    g.lineStyle(6, PALETTE.ink, 1);
    g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 20);
    g.fillStyle(PALETTE.cyan, 1);
    g.fillCircle(-cardW / 2 + 30, cardH / 2 - 26, 6);
    g.fillStyle(PALETTE.yellow, 1);
    g.fillCircle(cardW / 2 - 34, -cardH / 2 + 30, 5);
    this.panel.add(g);

    // Swallow taps on the card so only the dim area closes.
    const cardHit = scene.add.container(0, 0);
    cardHit.setSize(cardW, cardH);
    cardHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, cardW, cardH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    });
    this.panel.add(cardHit);

    // Content on top, centred in the card.
    content.setScale(fit);
    content.setPosition(-(contentW * fit) / 2, -(naturalH * fit) / 2);
    this.panel.add(content);

    // Close button — white disc + ink × at the top-right corner of the card.
    const bx = cardW / 2 - 22;
    const by = -cardH / 2 + 22;
    const close = scene.add.graphics();
    close.fillStyle(0xffffff, 1);
    close.fillCircle(bx, by, 15);
    close.lineStyle(3, PALETTE.ink, 1);
    close.strokeCircle(bx, by, 15);
    close.lineBetween(bx - 5, by - 5, bx + 5, by + 5);
    close.lineBetween(bx + 5, by - 5, bx - 5, by + 5);
    this.panel.add(close);
    const closeHit = scene.add.container(bx, by);
    closeHit.setSize(38, 38);
    closeHit.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(0, 0, 38, 38),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    closeHit.on('pointerdown', () => this.dismiss());
    this.panel.add(closeHit);

    if (first) {
      this.panel.setScale(0);
      this.panel.setRotation(-0.03);
      scene.tweens.add({
        targets: this.panel,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        duration: 380,
        ease: 'Back.easeOut',
      });
    }
  }

  /** Lay out the title, intro, and key rows, choosing a content WIDTH that hugs the
   *  material: one snug column, or two when the canvas can fit them. Returns the chosen
   *  width and total height so the caller can size the card to it. `maxInteriorW` is the
   *  widest the canvas allows. */
  private buildContent(maxInteriorW: number): {
    content: Phaser.GameObjects.Container;
    contentW: number;
    naturalH: number;
  } {
    const scene = this.scene;
    const content = scene.add.container(0, 0);
    const ICON = 34;
    const TEXT_X = ICON + 14;
    const colGap = 26;

    // Build the example pills up front so their widths drive the column width — the card
    // ends up exactly as wide as the widest worked example needs, plus the icon column.
    const examples = KEY_ROWS.map((r) => this.buildExample(r.example));
    const widestEx = Math.max(...examples.map((e) => e.width));
    const idealCol = TEXT_X + widestEx + 12;

    // Fit as many ideal columns as the canvas allows (capped at 2); if even one won't
    // fit, shrink the single column to the available width.
    let cols = Phaser.Math.Clamp(Math.floor((maxInteriorW + colGap) / (idealCol + colGap)), 1, 2);
    let cellW = idealCol;
    if (cols * cellW + (cols - 1) * colGap > maxInteriorW) {
      cols = 1;
      cellW = maxInteriorW;
    }
    const contentW = cols * cellW + (cols - 1) * colGap;

    let y = 0;
    const title = scene.add.text(0, y, 'HOW TO PLAY', {
      fontFamily: UI_FONT,
      fontSize: '28px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    content.add(title);
    y += title.height + 10;

    const intro = scene.add.text(0, y, INTRO, {
      fontFamily: UI_FONT,
      fontSize: '15px',
      fontStyle: '600',
      color: '#2b2d6e',
      wordWrap: { width: contentW },
      lineSpacing: 3,
    });
    content.add(intro);
    y += intro.height + 16;

    const section = scene.add.text(0, y, 'THE LINKS', {
      fontFamily: UI_FONT,
      fontSize: '14px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    content.add(section);
    y += section.height + 4;

    const divider = scene.add.graphics();
    divider.lineStyle(2, PALETTE.ink, 0.18);
    divider.lineBetween(0, y, contentW, y);
    content.add(divider);
    y += 12;

    for (let i = 0; i < KEY_ROWS.length; i += cols) {
      let rowH = 0;
      for (let col = 0; col < cols && i + col < KEY_ROWS.length; col++) {
        const cell = this.buildLinkCell(KEY_ROWS[i + col]!, examples[i + col]!, cellW);
        cell.container.setPosition(col * (cellW + colGap), y);
        content.add(cell.container);
        rowH = Math.max(rowH, cell.height);
      }
      y += rowH + 16;
    }

    return { content, contentW, naturalH: y };
  }

  /** One link entry — icon, name, meaning, and its (pre-built) example pill, stacked. */
  private buildLinkCell(
    row: KeyRow,
    ex: { container: Phaser.GameObjects.Container; width: number; height: number },
    cellW: number
  ): { container: Phaser.GameObjects.Container; height: number } {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const ICON = 34;
    const TEXT_X = ICON + 14;

    const name = scene.add.text(TEXT_X, 0, row.name, {
      fontFamily: UI_FONT,
      fontSize: '15px',
      fontStyle: '900',
      color: '#1c1c1c',
    });
    let ty = name.height + 1;

    const meaning = scene.add.text(TEXT_X, ty, row.meaning, {
      fontFamily: UI_FONT,
      fontSize: '13px',
      fontStyle: '600',
      color: '#6a6a6a',
      wordWrap: { width: cellW - TEXT_X },
    });
    ty += meaning.height + 6;

    ex.container.setPosition(TEXT_X, ty);
    ty += ex.height;

    const rowH = Math.max(ICON, ty);
    if (scene.textures.exists(row.tex)) {
      const icon = scene.add.image(ICON / 2, rowH / 2, row.tex);
      icon.setDisplaySize(ICON, ICON);
      c.add(icon);
    }
    c.add([name, meaning, ex.container]);
    return { container: c, height: rowH };
  }

  /** Build one example line: bold words, muted connectives, and (for letter subsets)
   *  per-letter highlighting — wrapped in a subtle pill so it stands apart from the text. */
  private buildExample(segs: ExampleSeg[]): {
    container: Phaser.GameObjects.Container;
    width: number;
    height: number;
  } {
    const scene = this.scene;
    const c = scene.add.container(0, 0);
    const padX = 11;
    const lineH = 24;
    const cy = lineH / 2;
    let x = padX;

    const glyph = (str: string, color: string, size: number, weight: string) => {
      const t = scene.add.text(x, cy, str, {
        fontFamily: UI_FONT,
        fontSize: `${size}px`,
        fontStyle: weight,
        color,
      });
      t.setOrigin(0, 0.5);
      c.add(t);
      x += t.width;
    };

    for (const seg of segs) {
      if (seg.kind === 'word') {
        glyph(seg.text, '#1c1c1c', 15, '900');
        x += 3;
      } else if (seg.kind === 'op') {
        x += 5;
        glyph(seg.text, '#8a8a8a', 13, '700');
        x += 8;
      } else {
        // Letters that belong to the subset light up pink; the rest are muted.
        for (let i = 0; i < seg.text.length; i++) {
          glyph(seg.text[i]!, seg.mask[i] ? '#ff2f8f' : '#c2beb4', 15, '900');
        }
        x += 3;
      }
    }

    const w = x - 3 + padX; // drop the trailing inter-segment gap, add right padding
    const bg = scene.add.graphics();
    bg.fillStyle(PALETTE.ink, 0.05);
    bg.fillRoundedRect(0, 0, w, lineH, lineH / 2);
    bg.lineStyle(1.5, PALETTE.ink, 0.14);
    bg.strokeRoundedRect(0, 0, w, lineH, lineH / 2);
    c.addAt(bg, 0);

    return { container: c, width: w, height: lineH };
  }

  /** Spring the card away, fade the dim, then destroy and notify. */
  private dismiss() {
    this.overlayHit.disableInteractive();
    this.scene.tweens.add({
      targets: this.panel,
      scaleX: 0,
      scaleY: 0,
      rotation: 0.04,
      duration: 220,
      ease: 'Back.easeIn',
    });
    this.scene.tweens.add({
      targets: this.overlay,
      alpha: 0,
      duration: 220,
      onComplete: () => {
        this.onClose();
        this.destroy();
      },
    });
  }
}
