import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  DeletePuzzleResponse,
  IncrementResponse,
  InitResponse,
  PublishPuzzleResponse,
  UserStreak,
} from '../../shared/api';
import { createPuzzlePost } from '../core/post';
import { cleanTitle, deletePuzzle, loadPuzzle, savePuzzle, validatePuzzle } from '../core/puzzleStore';
import { getDailyDay, getDailyPuzzles, setDailyPuzzles } from '../core/dailyStore';
import { puzzleForDifficulty } from '../../shared/dailyPuzzle';
import { utcDayNumber } from '../../shared/daily';
import { findBlockedTerm } from '../../shared/moderation';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

api.get('/init', async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error('API Init Error: postId not found in devvit context');
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from context',
      },
      400
    );
  }

  try {
    // Only postId/puzzle/dailyDay are actually consumed by the client (splash + boot) — the
    // count/username fields below are unused leftovers from the starter template. Skipping
    // reddit.getCurrentUsername() (a real network round-trip) shaves meaningful latency off
    // this call, which the client races against a short timeout (see primeBootPuzzle /
    // splash.ts's resolveCustom) — a slow /api/init used to lose that race and silently fall
    // back to the generic daily splash / menu.
    const [count, stored, dailyDay] = await Promise.all([
      redis.get('count'),
      loadPuzzle(postId),
      getDailyDay(postId),
    ]);

    // Present on a daily post: that day's FROZEN easy/hard puzzles, so a future bank
    // edit/regeneration can't retroactively change what this day showed.
    const dailyPuzzles = dailyDay != null ? await resolveDailyPuzzles(dailyDay) : null;

    // Only a community puzzle post needs to know who's asking (for the "delete my puzzle"
    // control) — this extra round-trip is skipped entirely on the much more common daily post.
    const isOwnPuzzle = stored
      ? ((await reddit.getCurrentUsername()) ?? null) === stored.author
      : false;

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: 'anonymous',
      // Only present for user-created puzzle posts; the daily post has nothing stored.
      ...(stored
        ? {
            puzzle: stored.puzzle,
            puzzleTitle: stored.title,
            puzzleAuthor: stored.author,
            postUrl: `https://reddit.com/r/${context.subredditName}/comments/${postId}`,
            isOwnPuzzle,
          }
        : {}),
      // Present on a daily post: which day's board to show (frozen at creation).
      ...(dailyDay != null ? { dailyDay } : {}),
      ...(dailyPuzzles ? { dailyPuzzles } : {}),
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = 'Unknown error during initialization';
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>(
      { status: 'error', message: errorMessage },
      400
    );
  }
});

// A player's daily-solve streak. Two Redis keys per user:
//   user:<id>:streak    — the current run length (integer, stored as a string)
//   user:<id>:streakDay — the UTC day number (see shared/daily) of their last counted solve
// Days are UTC day numbers so the streak rolls over at the same instant as the daily puzzle for
// everyone, rather than depending on each player's local midnight.
function streakKeys(userId: string) {
  return { count: `user:${userId}:streak`, day: `user:${userId}:streakDay` } as const;
}

/** The streak that is actually live for `today`: the stored run if the last solve was today or
 *  yesterday, otherwise 0 — a gap of two or more days means the run has lapsed. */
function liveStreak(storedCount: number, lastDay: number | null, today: number): number {
  if (lastDay === null) return 0;
  return lastDay === today || lastDay === today - 1 ? storedCount : 0;
}

/** Record a solve for the current user and return their (possibly extended) streak. Called by
 *  the win screen. Solving again on a day already counted leaves the run unchanged, so replays
 *  never inflate — or reset — the streak. */
api.post('/increment_streak', async (c) => {
  const user = context.userId;
  if (!user) {
    return c.json<ErrorResponse>({ status: 'error', message: 'No logged-in user.' }, 400);
  }

  const keys = streakKeys(user);
  const today = utcDayNumber();
  const [rawCount, rawDay] = await Promise.all([redis.get(keys.count), redis.get(keys.day)]);
  const lastDay = rawDay != null ? parseInt(rawDay, 10) : null;
  const prevCount = rawCount ? parseInt(rawCount, 10) : 0;

  let streak: number;
  if (lastDay === today) {
    streak = prevCount || 1; // already counted today — a replay doesn't extend the run
  } else if (lastDay === today - 1) {
    streak = prevCount + 1; // solved yesterday too → extend
  } else {
    streak = 1; // first solve ever, or the previous run lapsed → start fresh
  }

  await Promise.all([
    redis.set(keys.count, streak.toString()),
    redis.set(keys.day, today.toString()),
  ]);

  return c.json<UserStreak>({ type: 'streak', streak });
});

/** Read the current user's live streak for the menu — 0 when they have never solved or the run
 *  has lapsed (see liveStreak). Read-only: it never mutates the stored streak. */
api.get('/fetch_streak', async (c) => {
  const user = context.userId;
  if (!user) {
    return c.json<ErrorResponse>({ status: 'error', message: 'No logged-in user.' }, 400);
  }

  const keys = streakKeys(user);
  const [rawCount, rawDay] = await Promise.all([redis.get(keys.count), redis.get(keys.day)]);
  const streak = liveStreak(
    rawCount ? parseInt(rawCount, 10) : 0,
    rawDay != null ? parseInt(rawDay, 10) : null,
    utcDayNumber()
  );

  return c.json<UserStreak>({ type: 'streak', streak });
});

/** The frozen easy/hard puzzles for a daily's UTC day. Legacy days that predate the freeze
 *  (or where creation-time freezing failed) get backfilled here — locking them in from now on
 *  using whatever the bank looks like at this moment, so at least no FURTHER bank edit can
 *  move them. */
async function resolveDailyPuzzles(day: number) {
  const existing = await getDailyPuzzles(day);
  if (existing) return existing;
  const easy = puzzleForDifficulty('easy', day);
  const hard = puzzleForDifficulty('hard', day);
  if (!easy || !hard) return null;
  const puzzles = { easy, hard };
  await setDailyPuzzles(day, puzzles);
  return puzzles;
}

api.post('/increment', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', 1);
  return c.json<IncrementResponse>({
    count,
    postId,
    type: 'increment',
  });
});

api.post('/decrement', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', -1);
  return c.json<DecrementResponse>({
    count,
    postId,
    type: 'decrement',
  });
});

/**
 * Publish a user-created puzzle as its own Reddit post. Validates the payload, creates the
 * post, then stores the puzzle JSON in Redis keyed by the new post id — so opening that post
 * makes /api/init serve this puzzle. Returns the post URL for the client to navigate to.
 */
api.post('/puzzles/publish', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid request body.' }, 400);
  }

  const { title: rawTitle, puzzle: rawPuzzle } = (body ?? {}) as {
    title?: unknown;
    puzzle?: unknown;
  };
  const result = validatePuzzle(rawPuzzle);
  if (!result.ok) {
    return c.json<ErrorResponse>({ status: 'error', message: result.message }, 400);
  }
  const title = cleanTitle(rawTitle);

  // Hard gate on hate slurs (server-side, so it can't be bypassed by the client). The term
  // itself is not echoed back.
  const blocked = findBlockedTerm(title, ...result.puzzle.words.map((w) => w.text));
  if (blocked) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'That puzzle contains a term we don’t allow. Please revise it and try again.',
      },
      400
    );
  }

  try {
    const author = (await reddit.getCurrentUsername()) ?? 'someone';
    const post = await createPuzzlePost(title);
    await savePuzzle(post.id, result.puzzle, title, author);

    return c.json<PublishPuzzleResponse>({
      type: 'publish',
      status: 'ok',
      postId: post.id,
      url: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error('Error publishing puzzle:', error);
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Could not publish the puzzle. Try again.' },
      500
    );
  }
});

/**
 * Delete a community puzzle's own post. Only the puzzle's original creator may do this —
 * checked against the stored `author` (see puzzleStore.savePuzzle) by the requesting user's
 * actual Reddit username, never a client-supplied claim. The post itself is created by the
 * app account (see core/post.createPuzzlePost), so deleting it is a plain app-level
 * `post.delete()` rather than anything requiring extra Reddit permissions.
 */
api.post('/puzzles/delete', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required' }, 400);
  }

  const stored = await loadPuzzle(postId);
  if (!stored) {
    return c.json<ErrorResponse>({ status: 'error', message: 'No puzzle found for this post.' }, 404);
  }

  const username = await reddit.getCurrentUsername();
  if (!username || username !== stored.author) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Only the puzzle\'s creator can delete it.' },
      403
    );
  }

  try {
    const post = await reddit.getPostById(postId as `t3_${string}`);
    await post.delete();
    await deletePuzzle(postId);

    return c.json<DeletePuzzleResponse>({
      type: 'delete',
      status: 'ok',
      subredditUrl: `https://reddit.com/r/${context.subredditName}`,
    });
  } catch (error) {
    console.error(`Error deleting puzzle post ${postId}:`, error);
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Could not delete the puzzle. Try again.' },
      500
    );
  }
});
