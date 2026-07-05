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

/** The puzzle currently loaded by PuzzleScene. */
export const activePuzzle: Puzzle = meteorPuzzle;
