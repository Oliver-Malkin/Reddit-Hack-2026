import type { LinkType } from './types';

/**
 * A demo "gallery" — one row per link type so each chain's visual can be compared at a
 * glance. `left`/`right` map to a chain's from/to (direction matters for the directional
 * types: hypernym, meronym, lettersubset, sequence).
 */
export type GalleryRow = {
  type: LinkType;
  left: string; // from
  right: string; // to
};

// Deliberately DIFFERENT words from the "How to Play" key (HelpPopup) so a player who
// meets both gets two worked examples of every link type, not the same one twice.
export const galleryRows: GalleryRow[] = [
  { type: 'synonym', left: 'FAST', right: 'QUICK' },
  { type: 'antonym', left: 'UP', right: 'DOWN' },
  { type: 'hypernym', left: 'DOG', right: 'HUSKY' }, // DOG is the broader category (apex → HUSKY)
  { type: 'anagram', left: 'EARTH', right: 'HEART' },
  { type: 'meronym', left: 'WHEEL', right: 'CAR' }, // WHEEL is part of CAR
  { type: 'lettersubset', left: 'CAT', right: 'SCATTER' }, // C-A-T hide inside SCATTER
  { type: 'sequence', left: 'ACORN', right: 'OAK' }, // ACORN grows into OAK
  { type: 'rhyme', left: 'BEE', right: 'TREE' },
];
