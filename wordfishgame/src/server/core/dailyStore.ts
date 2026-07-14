import { redis } from '@devvit/web/server';
import type { Puzzle } from '../../shared/puzzle';

/**
 * Redis bookkeeping for the rotating daily post.
 *
 *  - `daily:current` holds the id of the post that is currently pinned as the daily, so the
 *    scheduler can unpin it when the next day's post takes over.
 *  - `daily:day:<postId>` freezes which UTC day a given daily post represents, so /api/init can
 *    serve that day's board for a historical daily rather than today's (see shared/daily).
 *  - `daily:puzzles:<day>` freezes the actual easy/hard puzzle CONTENT for that day. Without
 *    this, the content is recomputed on every request from the live puzzleBank indexed by day
 *    number (see shared/dailyPuzzle) — so regenerating/editing the bank retroactively changes
 *    what a historical daily post shows. Freezing it once (at post-creation, or lazily on first
 *    /api/init for a legacy day — see routes/api.ts) locks that day's board in for good.
 */

const CURRENT_KEY = 'daily:current';
const dayKey = (postId: string) => `daily:day:${postId}`;
const puzzlesKey = (day: number) => `daily:puzzles:${day}`;

export async function getCurrentDailyPostId(): Promise<string | null> {
  return (await redis.get(CURRENT_KEY)) ?? null;
}

export async function setCurrentDailyPostId(postId: string): Promise<void> {
  await redis.set(CURRENT_KEY, postId);
}

export async function setDailyDay(postId: string, day: number): Promise<void> {
  await redis.set(dayKey(postId), String(day));
}

/** The UTC day a daily post was frozen to, or null if this post isn't a recorded daily. */
export async function getDailyDay(postId: string): Promise<number | null> {
  const raw = await redis.get(dayKey(postId));
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export type DailyPuzzles = { easy: Puzzle; hard: Puzzle };

/** The frozen easy/hard puzzles for a given UTC day, or null if never frozen. */
export async function getDailyPuzzles(day: number): Promise<DailyPuzzles | null> {
  const raw = await redis.get(puzzlesKey(day));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DailyPuzzles>;
    if (parsed && parsed.easy && parsed.hard) return { easy: parsed.easy, hard: parsed.hard };
    return null;
  } catch {
    return null;
  }
}

/** Freeze a UTC day's easy/hard puzzles permanently. */
export async function setDailyPuzzles(day: number, puzzles: DailyPuzzles): Promise<void> {
  await redis.set(puzzlesKey(day), JSON.stringify(puzzles));
}
