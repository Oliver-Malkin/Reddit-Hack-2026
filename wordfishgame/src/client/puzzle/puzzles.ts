import type { Puzzle } from './types';

/** DOG ⊃ (HUSKY) = RASPY — the hidden middle word links both clues. */
export const dogPuzzle: Puzzle = {
  words: [
    { id: 'dog', text: 'DOG' },
    { id: 'mystery', text: 'HUSKY', hidden: true },
    { id: 'raspy', text: 'RASPY' },
  ],
  links: [
    { type: 'hypernym', from: 'dog', to: 'mystery' },
    { type: 'synonym', from: 'mystery', to: 'raspy' },
  ],
};

/**
 * METEOR ~ (REMOTE) = DISTANT.
 * REMOTE is an anagram of METEOR and a synonym of DISTANT — solve the middle.
 */
export const meteorPuzzle: Puzzle = {
  words: [
    { id: 'meteor', text: 'METEOR' },
    { id: 'mystery', text: 'REMOTE', hidden: true },
    { id: 'distant', text: 'DISTANT' },
  ],
  links: [
    { type: 'anagram', from: 'meteor', to: 'mystery' },
    { type: 'synonym', from: 'mystery', to: 'distant' },
  ],
};

/**
 * CHICKEN → (EGG) → CHICKEN, plus EGG ⊂ HEDGEHOG.
 * The cycle is drawn with CHICKEN written twice — one tile that becomes the egg and a
 * second the egg becomes — so EGG is a hub linked to three separate words (rather than
 * one word linked to itself, which would draw two chains on top of each other). EGG is
 * also spelled entirely with letters found inside HEDGEHOG (h-E-d-G-e-h-o-G).
 */
export const chickenPuzzle: Puzzle = {
  words: [
    { id: 'chicken1', text: 'CHICKEN' },
    { id: 'mystery', text: 'EGG', hidden: true },
    { id: 'chicken2', text: 'CHICKEN' },
    { id: 'hedgehog', text: 'HEDGEHOG' },
  ],
  links: [
    { type: 'sequence', from: 'chicken1', to: 'mystery' }, // chicken → egg
    { type: 'sequence', from: 'mystery', to: 'chicken2' }, // egg → chicken
    { type: 'lettersubset', from: 'mystery', to: 'hedgehog' }, // E,G,G hide inside HEDGEHOG
  ],
};

/** The puzzle currently loaded by PuzzleScene. */
export const activePuzzle: Puzzle = chickenPuzzle;
