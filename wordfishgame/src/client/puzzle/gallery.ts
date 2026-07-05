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

export const galleryRows: GalleryRow[] = [
  { type: 'synonym', left: 'BIG', right: 'LARGE' },
  { type: 'antonym', left: 'HOT', right: 'COLD' },
  { type: 'hypernym', left: 'BIRD', right: 'ROBIN' }, // BIRD is the broader category (apex → ROBIN)
  { type: 'anagram', left: 'LISTEN', right: 'SILENT' },
  { type: 'meronym', left: 'PETAL', right: 'FLOWER' }, // PETAL is part of FLOWER
  { type: 'lettersubset', left: 'CLAM', right: 'ACCLAIM' }, // C-L-A-M hide inside ACCLAIM
  { type: 'sequence', left: 'ACORN', right: 'TREE' }, // ACORN grows into TREE
  { type: 'rhyme', left: 'MOON', right: 'SPOON' },
];
