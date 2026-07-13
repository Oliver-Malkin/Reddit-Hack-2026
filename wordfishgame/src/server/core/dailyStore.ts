import { redis } from '@devvit/web/server';

/**
 * Redis bookkeeping for the rotating daily post.
 *
 *  - `daily:current` holds the id of the post that is currently pinned as the daily, so the
 *    scheduler can unpin it when the next day's post takes over.
 *  - `daily:day:<postId>` freezes which UTC day a given daily post represents, so /api/init can
 *    serve that day's board for a historical daily rather than today's (see shared/daily).
 */

const CURRENT_KEY = 'daily:current';
const dayKey = (postId: string) => `daily:day:${postId}`;

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
