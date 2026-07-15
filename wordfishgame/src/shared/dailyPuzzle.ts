import type { Puzzle } from './puzzle';
import { easyPuzzles, hardPuzzles } from './puzzleBank';
import { utcDayNumber } from './daily';

export type Difficulty = 'easy' | 'hard';

/**
 * The puzzle for a given difficulty on a given day, drawn from the generated bank (see
 * scripts/puzzlegen). The bank is pre-shuffled, so stepping through it by day gives varied
 * puzzles with no repeats until the whole bank has been played.
 *
 * `day` defaults to the live UTC day. Shared by the client (rendering a daily whose content
 * hasn't been frozen yet — legacy posts, local preview) and the server (freezing each day's
 * puzzle at post-creation time / first request — see server/core/dailyStore and
 * server/core/post.ts). Returns null only if the relevant bank is empty.
 */
export function puzzleForDifficulty(
  difficulty: Difficulty,
  day: number = utcDayNumber()
): Puzzle | null {
  const bank = difficulty === 'hard' ? hardPuzzles : easyPuzzles;
  if (bank.length === 0) return null;
  return bank[((day % bank.length) + bank.length) % bank.length]!;
}
