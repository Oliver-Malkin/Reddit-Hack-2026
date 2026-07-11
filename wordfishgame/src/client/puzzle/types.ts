/** Client-facing puzzle types. The data model itself lives in `shared/puzzle` so the
 *  server can validate + store the same shape; this module re-exports it (keeping every
 *  existing `from './types'` import working) and adds the client-only menu Difficulty. */

export type { LinkType, PuzzleWord, PuzzleLink, Puzzle } from '../../shared/puzzle';
export { LINK_TYPES } from '../../shared/puzzle';

/** The two daily difficulties offered on the menu. */
export type Difficulty = 'easy' | 'hard';
