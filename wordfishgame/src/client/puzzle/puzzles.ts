import type { Difficulty, Puzzle } from './types';
import { easyPuzzles, hardPuzzles } from './puzzleBank';

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

// ---------- TODAY'S DAILY PUZZLES ----------

/**
 * EASY — APPLE ⊃ (CORE) ⊂ LICORICE.
 * CORE is a part of an APPLE, and its letters hide in order inside LICORICE
 * (li-C-O-R-i-c-E). One hidden word, two clues either side of it.
 */
export const applePuzzle: Puzzle = {
  words: [
    { id: 'apple', text: 'APPLE' },
    { id: 'core', text: 'CORE', hidden: true },
    { id: 'licorice', text: 'LICORICE' },
  ],
  links: [
    { type: 'meronym', from: 'core', to: 'apple' }, // CORE is part of APPLE
    { type: 'lettersubset', from: 'core', to: 'licorice' }, // C,O,R,E hide inside LICORICE
  ],
};

/**
 * HARD — VARIETY = (RANGE) ~ (ANGER) → BARGAINING.
 * Two hidden words chained in a line: RANGE is a synonym of VARIETY, ANGER is an
 * anagram of RANGE, and ANGER "becomes" BARGAINING (the stages of grief). Both middle
 * words must be filled to win.
 */
export const grievePuzzle: Puzzle = {
  words: [
    { id: 'variety', text: 'VARIETY' },
    { id: 'range', text: 'RANGE', hidden: true },
    { id: 'anger', text: 'ANGER', hidden: true },
    { id: 'bargaining', text: 'BARGAINING' },
  ],
  links: [
    { type: 'synonym', from: 'variety', to: 'range' }, // VARIETY = RANGE
    { type: 'anagram', from: 'range', to: 'anger' }, // RANGE ↔ ANGER
    { type: 'sequence', from: 'anger', to: 'bargaining' }, // ANGER becomes BARGAINING
  ],
};

/** UTC day number — everyone worldwide flips to the next puzzle at the same moment. */
const dayNumber = () => Math.floor(Date.now() / 86_400_000);

/**
 * Today's puzzle for a given difficulty, drawn from the generated bank
 * (see scripts/puzzlegen). The bank is pre-shuffled, so stepping through it by day
 * gives varied puzzles with no repeats until the whole bank has been played.
 * Falls back to the handcrafted puzzles if a bank is ever empty.
 */
export function puzzleForDifficulty(difficulty: Difficulty): Puzzle {
  const bank = difficulty === 'hard' ? hardPuzzles : easyPuzzles;
  const daily = bank[dayNumber() % Math.max(bank.length, 1)];
  return daily ?? (difficulty === 'hard' ? grievePuzzle : applePuzzle);
}

/** Fallback puzzle when the scene is booted directly (e.g. debugging) with no difficulty. */
export const activePuzzle: Puzzle = applePuzzle;
