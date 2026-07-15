import { reddit } from '@devvit/web/server';
import type { Post } from '@devvit/web/server';
import { utcDayNumber, utcDayLabel } from '../../shared/daily';
import { puzzleForDifficulty } from '../../shared/dailyPuzzle';
import {
  getCurrentDailyPostId,
  setCurrentDailyPostId,
  setDailyDay,
  setDailyPuzzles,
} from './dailyStore';
import { getShareImageUrl } from './shareImage';

/**
 * Publish today's daily WordFish post and make it the pinned announcement.
 *
 * Called from the daily scheduler (00:00 UTC), on app install (so the sub isn't empty until
 * the first cron fires), and from the mod "create a new post" menu item — all share this one
 * path so there's a single pinned daily at a time. The new post is frozen to the current UTC
 * day (see dailyStore) so opening it later still serves that day's board. The new post is
 * pinned FIRST (never a gap with nothing pinned) and the previous daily is then unpinned —
 * best-effort, since it may since have been deleted.
 */
export const publishDailyPost = async (): Promise<Post> => {
  const day = utcDayNumber();
  const previousId = await getCurrentDailyPostId();
  const shareImageUrl = await getShareImageUrl();

  const post = await reddit.submitCustomPost({
    title: `WordFish daily: ${utcDayLabel(day)}`,
    styles: shareImageUrl ? { shareImageUrl } : undefined,
  });

  await setDailyDay(post.id, day);
  await setCurrentDailyPostId(post.id);

  // Freeze today's easy/hard puzzles now, while the bank looks exactly like this — so a
  // future edit/regeneration of the bank can never retroactively change what this day showed.
  const easy = puzzleForDifficulty('easy', day);
  const hard = puzzleForDifficulty('hard', day);
  if (easy && hard) await setDailyPuzzles(day, { easy, hard });

  try {
    await post.sticky(1); // pin as the subreddit's #1 announcement
  } catch (err) {
    console.error(`Failed to pin daily post ${post.id}:`, err);
  }

  if (previousId && previousId !== post.id) {
    try {
      const previous = await reddit.getPostById(previousId as `t3_${string}`);
      await previous.unsticky();
    } catch (err) {
      console.error(`Failed to unpin previous daily post ${previousId}:`, err);
    }
  }

  return post;
};

/** Create a Reddit post for a user-created puzzle. The puzzle JSON itself is stored in Redis
 *  keyed by the returned post id (see puzzleStore); opening the post loads it. Community
 *  puzzles are never pinned — only the daily is. */
export const createPuzzlePost = async (title: string) => {
  const shareImageUrl = await getShareImageUrl();
  return await reddit.submitCustomPost({
    title: `WordFish: ${title}`,
    styles: shareImageUrl ? { shareImageUrl } : undefined,
  });
};
