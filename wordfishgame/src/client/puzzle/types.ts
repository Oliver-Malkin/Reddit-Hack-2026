/** Puzzle data model — puzzles are plain data so they can eventually be served
 *  by a backend (e.g. a Devvit app handing the client a daily puzzle JSON). */

export type LinkType =
  | 'synonym' // X means the same as Y
  | 'antonym' // X means the opposite of Y
  | 'hypernym' // X is a broader category than Y (and hyponym is just this, reversed)
  | 'anagram' // X is Y's letters rearranged
  | 'meronym' // X is a part of Y (petal → flower)
  | 'lettersubset' // X's letters sit inside Y's spelling (clam → acclaim)
  | 'sequence' // X becomes / precedes Y over time (acorn → tree)
  | 'rhyme'; // X sounds like Y (moon ~ spoon)

export type PuzzleWord = {
  id: string;
  /** The word itself — for hidden words this is the ANSWER; it renders as "?" per letter. */
  text: string;
  hidden?: boolean;
};

export type PuzzleLink = {
  type: LinkType;
  /**
   * Word ids at each end. Direction only matters for hypernym links:
   * `from` is the HYPERNYM (the superset / more general word) and `to` is the
   * hyponym — e.g. { type: 'hypernym', from: 'dog', to: 'husky' } reads
   * "DOG is a hypernym of HUSKY" (dog ⊃ husky).
   *
   * There is deliberately no separate 'hyponym' type: "A is a hyponym of B" is
   * exactly "B is a hypernym of A", so it's stored as a hypernym with the ends
   * swapped. One directional chevron for the containment relation keeps the
   * visual language unambiguous. synonym/antonym/anagram are all symmetric, so
   * their direction is ignored.
   */
  from: string;
  to: string;
};

export type Puzzle = {
  words: PuzzleWord[];
  links: PuzzleLink[];
};

/** The two daily difficulties offered on the menu. */
export type Difficulty = 'easy' | 'hard';
