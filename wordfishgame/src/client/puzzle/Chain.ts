import Phaser from 'phaser';
import { PALETTE, UI_FONT } from '../theme';
import type { LinkType } from './types';
import type { WordTile } from './WordTile';

const SHAPE_COUNT = 8;
/** Chains wobble fully at/below this length and settle as they stretch taut. */
const SLACK_REF = 250;
/** Gap between a tile's border and the first chain shape. */
const TILE_GAP = 14;

/** Human-facing chip text — often clearer than the raw type name. */
const CHIP_LABEL: Record<LinkType, string> = {
  synonym: 'SYNONYM',
  antonym: 'ANTONYM',
  hypernym: 'IS A ▸', // BIRD is-a-category-of ROBIN; arrow points to the narrower word
  anagram: 'ANAGRAM',
  meronym: 'PART OF ▸',
  lettersubset: 'LETTERS IN ▸',
  sequence: 'BECOMES ▸',
  rhyme: 'RHYMES',
};

/** Types whose shapes carry a direction and so lock to the chain heading (apex → `to`). */
const DIRECTIONAL = new Set<LinkType>(['hypernym', 'sequence', 'rhyme', 'lettersubset']);
/** Types drawn upright so a legible glyph (= / ≠) always reads. */
const UPRIGHT = new Set<LinkType>(['synonym', 'antonym']);

/**
 * A stretchy chain of shapes linking two word tiles. The shape COUNT is constant —
 * dragging tiles apart only widens the spacing. Shapes wobble perpendicular to the
 * chain (less when taut). Motion + form per type carry the relation's meaning:
 *
 * - synonym      "=" coins (white)          — equality; upright.
 * - antonym      "≠" coins (ink, inverse of synonym) — opposition; upright.
 * - hypernym     chevrons (yellow)          — category-of; apex → the narrower word.
 * - anagram      "⟳" mix coins (cyan)       — letters stirred; the glyph itself spins.
 * - meronym      nested squares (purple)    — a part inside a whole; slow turn.
 * - lettersubset arrow-into-bracket (navy)  — letters fly INTO the containing word.
 * - sequence     arrowheads (green)         — grows/precedes; shapes SWELL toward `to`.
 * - rhyme        sound-wave arcs (pink)     — sounds alike; arcs radiate along the chain.
 */
export class Chain {
  private scene: Phaser.Scene;
  readonly type: LinkType;
  private tileA: WordTile;
  private tileB: WordTile;

  private shapes: Phaser.GameObjects.Image[] = [];
  private baseScales: number[] = [];
  private chip: Phaser.GameObjects.Container;
  private phases: number[] = [];
  private wobbleSpeeds: number[] = [];
  private amps: number[] = [];
  private spinSpeeds: number[] = [];

  /** Direction is A → B: for the directional types A is the "from" end. */
  constructor(scene: Phaser.Scene, type: LinkType, tileA: WordTile, tileB: WordTile) {
    this.scene = scene;
    this.type = type;
    this.tileA = tileA;
    this.tileB = tileB;

    const textures = this.texturesForType();
    for (let i = 0; i < SHAPE_COUNT; i++) {
      // Sequence swells from small (start) to large (end) to show growth over time;
      // everything else is uniform with a little jitter.
      const scale =
        type === 'sequence'
          ? Phaser.Math.Linear(0.34, 0.74, i / (SHAPE_COUNT - 1))
          : 0.5 * Phaser.Math.FloatBetween(0.85, 1.12); // textures baked at 2x
      const img = scene.add.image(0, 0, textures[i % textures.length]!).setScale(scale).setDepth(2);
      this.shapes.push(img);
      this.baseScales.push(scale);
      this.phases.push(Phaser.Math.FloatBetween(0, Math.PI * 2));
      this.wobbleSpeeds.push(Phaser.Math.FloatBetween(1.4, 2.4));
      this.amps.push(Phaser.Math.FloatBetween(3.5, 7));
      this.spinSpeeds.push(Phaser.Math.FloatBetween(0.25, 0.7) * (Math.random() < 0.5 ? -1 : 1));
    }
    this.chip = this.buildChip();
  }

  private texturesForType(): string[] {
    switch (this.type) {
      case 'synonym':
        return ['chain-eq'];
      case 'antonym':
        return ['chain-neq'];
      case 'hypernym':
        return ['chain-chevron-ink', 'chain-chevron-yellow'];
      case 'anagram':
        return ['chain-mix'];
      case 'meronym':
        return ['chain-meronym'];
      case 'lettersubset':
        return ['chain-into'];
      case 'sequence':
        return ['chain-seq'];
      case 'rhyme':
        return ['chain-rhyme'];
    }
  }

  private buildChip(): Phaser.GameObjects.Container {
    const label = this.scene.add.text(0, 0, CHIP_LABEL[this.type], {
      fontFamily: UI_FONT,
      fontSize: '12px',
      fontStyle: '800',
      color: '#1c1c1c',
    });
    label.setOrigin(0.5);

    const w = label.width + 24;
    const h = 26;
    const g = this.scene.add.graphics();
    g.fillStyle(PALETTE.ink, 0.16); // offset shadow
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 4, w, h, h / 2);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    g.lineStyle(3, PALETTE.ink, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);

    return this.scene.add.container(0, 0, [g, label]).setDepth(4);
  }

  update(time: number) {
    const a = this.tileA.chainAnchor();
    const b = this.tileB.chainAnchor();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    // Trim the chain so it starts/ends just outside each tile's border.
    const trimA = this.tileA.edgeDistance(ux, uy) + TILE_GAP;
    const trimB = this.tileB.edgeDistance(ux, uy) + TILE_GAP;
    const usable = Math.max(dist - trimA - trimB, 8);
    const startX = a.x + ux * trimA;
    const startY = a.y + uy * trimA;

    // Wobble amplitude fades as the chain is stretched taut.
    const slack = Phaser.Math.Clamp(SLACK_REF / usable, 0.2, 1);
    const px = -uy; // perpendicular
    const py = ux;
    const heading = Math.atan2(dy, dx);
    const t = time * 0.001;

    for (let i = 0; i < SHAPE_COUNT; i++) {
      const img = this.shapes[i]!;
      const phase = this.phases[i]!;
      const wobbleSpeed = this.wobbleSpeeds[i]!;
      const along = ((i + 0.5) / SHAPE_COUNT) * usable;
      const wobble = Math.sin(t * wobbleSpeed + phase) * this.amps[i]! * slack;
      img.setPosition(startX + ux * along + px * wobble, startY + uy * along + py * wobble);

      const shimmy = Math.sin(t * wobbleSpeed + phase);
      if (DIRECTIONAL.has(this.type)) {
        img.rotation = heading + shimmy * 0.12; // glyph points from A toward B
      } else if (UPRIGHT.has(this.type)) {
        img.rotation = shimmy * 0.14; // stays readable, just a gentle rock
      } else if (this.type === 'meronym') {
        img.rotation = shimmy * 0.5; // slow quarter-turn sway
      } else {
        img.rotation = t * this.spinSpeeds[i]! + phase; // antonym, anagram: free spin
      }
    }

    // When tiles are pushed together the chain has nowhere to live — fade the shapes
    // and chip out instead of letting them pile up under the tiles.
    const shapeAlpha = Phaser.Math.Clamp((usable - 24) / 60, 0, 1);
    for (const img of this.shapes) img.setAlpha(shapeAlpha);

    // Label chip rides the midpoint with a gentle sway.
    this.chip.setPosition(startX + ux * usable * 0.5, startY + uy * usable * 0.5);
    this.chip.rotation = Math.sin(t * 0.9) * 0.035;
    this.chip.setAlpha(Phaser.Math.Clamp((usable - 60) / 80, 0, 1));
  }

  /** Bake the chain shape textures once per scene (2x resolution, displayed at ~0.5). */
  static bakeTextures(scene: Phaser.Scene) {
    if (scene.textures.exists('chain-eq')) return;

    const ink = '#1c1c1c';
    const TAU = Math.PI * 2;
    const bake = (key: string, size: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
      const tex = scene.textures.createCanvas(key, size * 2, size * 2)!;
      const ctx = tex.context;
      ctx.clearRect(0, 0, size * 2, size * 2);
      ctx.save();
      ctx.scale(2, 2);
      ctx.translate(size / 2, size / 2);
      draw(ctx);
      ctx.restore();
      tex.refresh();
    };

    // Synonym — white coin stamped with an ink "=": equal, orderly.
    bake('chain-eq', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillStyle = ink;
      const bar = (y: number) => {
        ctx.beginPath();
        ctx.roundRect(-5.5, y, 11, 2.6, 1.3);
        ctx.fill();
      };
      bar(-3.6);
      bar(1.0);
    });

    // Antonym — the synonym coin colour-inverted: ink coin, white "≠".
    bake('chain-neq', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      const bar = (y: number) => {
        ctx.beginPath();
        ctx.roundRect(-5.5, y, 11, 2.6, 1.3);
        ctx.fill();
      };
      bar(-3.6);
      bar(1.0);
      // the strike-through that turns = into ≠
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-3.6, 6.8);
      ctx.lineTo(3.6, -6.8);
      ctx.stroke();
    });

    // Hypernym — chevron ">" pointing +x (apex → the hyponym). Yellow variant outlined.
    const chevron = (color: string | null) => (ctx: CanvasRenderingContext2D) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-5.5, -8.5);
        ctx.lineTo(7, 0);
        ctx.lineTo(-5.5, 8.5);
      };
      path();
      ctx.lineWidth = color ? 8 : 5.5;
      ctx.strokeStyle = ink;
      ctx.stroke();
      if (color) {
        path();
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    };
    bake('chain-chevron-ink', 26, chevron(null));
    bake('chain-chevron-yellow', 26, chevron('#f5b727'));

    // Anagram — cyan coin with a "⟳" mix glyph: two chasing arcs with arrowheads.
    // The chain spins these freely, so the rotation symbol literally rotates.
    bake('chain-mix', 26, (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fillStyle = '#2ec4d6';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink;
      ctx.stroke();

      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      const r = 5.2;
      const arrowArc = (a0: number, a1: number) => {
        ctx.beginPath();
        ctx.arc(0, 0, r, a0, a1);
        ctx.stroke();
        // arrowhead at the arc's end, pointing along the direction of travel
        const hx = Math.cos(a1) * r;
        const hy = Math.sin(a1) * r;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(a1 + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(3, 0);
        ctx.lineTo(-1.6, 2.3);
        ctx.lineTo(-1.6, -2.3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      arrowArc(-2.5, -0.6);
      arrowArc(-2.5 + Math.PI, -0.6 + Math.PI);
    });

    // Meronym — a small purple square nested inside a larger outline: a part within a whole.
    bake('chain-meronym', 26, (ctx) => {
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.roundRect(-10, -10, 20, 20, 4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(-4.5, -4.5, 9, 9, 2);
      ctx.fillStyle = '#8e44ad';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.stroke();
    });

    // Letter-subset — an arrow flying INTO a bracket, drawn pointing +x. The chain
    // heading-locks these, so the letters visibly stream toward the containing word.
    bake('chain-into', 26, (ctx) => {
      const navy = '#2b2d6e';
      ctx.strokeStyle = navy;
      ctx.fillStyle = navy;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // the receiving bracket "]"
      ctx.beginPath();
      ctx.moveTo(2.5, -8);
      ctx.lineTo(8, -8);
      ctx.lineTo(8, 8);
      ctx.lineTo(2.5, 8);
      ctx.stroke();
      // arrow entering it
      ctx.beginPath();
      ctx.moveTo(-9.5, 0);
      ctx.lineTo(-0.5, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4.5, 0);
      ctx.lineTo(-1.5, 3.4);
      ctx.lineTo(-1.5, -3.4);
      ctx.closePath();
      ctx.fill();
    });

    // Sequence — green arrowhead pointing +x (toward the later word). Shapes also swell
    // toward the end (see constructor) to read as growth over time.
    bake('chain-seq', 26, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(-4, -7.5);
      ctx.lineTo(6.5, 0);
      ctx.lineTo(-4, 7.5);
      ctx.closePath();
      ctx.fillStyle = '#27ae60';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.lineJoin = 'round';
      ctx.stroke();
    });

    // Rhyme — concentric pink arcs radiating from a dot: sound waves.
    bake('chain-rhyme', 26, (ctx) => {
      ctx.strokeStyle = '#ff2f8f';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      for (const r of [4, 8, 12]) {
        ctx.beginPath();
        ctx.arc(-7, 0, r, -0.8, 0.8);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff2f8f';
      ctx.beginPath();
      ctx.arc(-7, 0, 1.8, 0, TAU);
      ctx.fill();
    });
  }
}
