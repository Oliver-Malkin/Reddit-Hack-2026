import { context, redis, reddit } from '@devvit/web/server';

// Streak flair tiers — the longer the run, the bigger the catch. Fibonacci day counts so the
// early tiers come quickly (hook the habit) and the later ones stay aspirational. Checked
// top-down: a player wears the largest creature their streak has earned.
const STREAK_TIERS: ReadonlyArray<readonly [days: number, creature: string]> = [
  [55, '🦈'],
  [34, '🐙'],
  [21, '🦞'],
  [13, '🦑'],
  [8, '🦀'],
  [5, '🐡'],
  [3, '🦐'],
  [2, '🐠'],
  [1, '🐟'],
];

/** The sea creature a streak of `days` has earned, or null for no streak at all. */
export function streakCreature(days: number): string | null {
  for (const [threshold, creature] of STREAK_TIERS) {
    if (days >= threshold) return creature;
  }
  return null;
}

/**
 * Give the player a subreddit flair matching their streak (e.g. "🦀 8-day streak"), so the
 * badge follows their name around the sub. Deduped through Redis (`user:<id>:flairStreak`)
 * so a same-day replay doesn't re-issue an identical flair call. Strictly best-effort:
 * flair is decoration, so any failure here (missing mod perms, deleted account, network)
 * is logged and swallowed — it must never break recording the solve itself.
 */
export async function syncStreakFlair(userId: string, streak: number): Promise<void> {
  try {
    const creature = streakCreature(streak);
    if (!creature) return;

    const dedupeKey = `user:${userId}:flairStreak`;
    const last = await redis.get(dedupeKey);
    if (last != null && parseInt(last, 10) === streak) return;

    const subredditName = context.subredditName;
    const username = await reddit.getCurrentUsername();
    if (!subredditName || !username) return;

    await reddit.setUserFlair({
      subredditName,
      username,
      text: `${creature} ${streak}-day streak`,
      // The game's Memphis yellow with dark text — same look as the menu's streak badge.
      backgroundColor: '#f5b727',
      textColor: 'dark',
    });
    await redis.set(dedupeKey, streak.toString());
  } catch (error) {
    console.error(`Failed to sync streak flair for user ${userId}:`, error);
  }
}
