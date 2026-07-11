/** Canonical puzzle data model — shared by the client (renders/edits puzzles) and the
 *  server (validates + stores user-created puzzles, serves the daily). Puzzles are plain
 *  data so a Devvit post can hand the client a puzzle JSON to play. */

export type LinkType =
  | 'synonym' // X means the same as Y
  | 'antonym' // X means the opposite of Y
  | 'hypernym' // X is a broader category than Y (and hyponym is just this, reversed)
  | 'anagram' // X is Y's letters rearranged
  | 'meronym' // X is a part of Y (petal → flower)
  | 'lettersubset' // X's letters sit inside Y's spelling (clam → acclaim)
  | 'sequence' // X becomes / precedes Y over time (acorn → tree)
  | 'rhyme'; // X sounds like Y (moon ~ spoon)

/** Every link type for the editor's link-type picker. `label` is short enough to survive a
 *  narrow <select> without truncating and reads as a sentence between the two word pickers
 *  ("FISH · letters hide in · FOOLISH"); `hint` is the full explanation (tooltip text).
 *  Order is the order shown to creators. */
export const LINK_TYPES: readonly { type: LinkType; label: string; hint: string }[] = [
  { type: 'synonym', label: 'means same as', hint: 'Synonym — FAST means the same as QUICK' },
  { type: 'antonym', label: 'means opposite of', hint: 'Antonym — UP means the opposite of DOWN' },
  { type: 'anagram', label: 'anagram of', hint: 'Anagram — EARTH is HEART with its letters rearranged' },
  { type: 'rhyme', label: 'rhymes with', hint: 'Rhyme — MOON sounds like SPOON' },
  { type: 'hypernym', label: 'category of', hint: 'Category — DOG is the broader category containing HUSKY' },
  { type: 'meronym', label: 'part of', hint: 'Part — a WHEEL is part of a CAR' },
  { type: 'lettersubset', label: 'letters hide in', hint: 'Hidden letters — C, A, T sit in order inside SCATTER' },
  { type: 'sequence', label: 'becomes', hint: 'Becomes — an ACORN becomes an OAK over time' },
] as const;

export type PuzzleWord = {
  id: string;
  /** The word itself — for hidden words this is the ANSWER; it renders as "?" per letter. */
  text: string;
  hidden?: boolean;
};

export type PuzzleLink = {
  type: LinkType;
  /**
   * Word ids at each end. Direction only matters for the directional types (hypernym,
   * meronym, lettersubset, sequence). For hypernym, `from` is the HYPERNYM (broader word);
   * synonym/antonym/anagram/rhyme are symmetric so their direction is ignored.
   */
  from: string;
  to: string;
};

export type Puzzle = {
  words: PuzzleWord[];
  links: PuzzleLink[];
};
