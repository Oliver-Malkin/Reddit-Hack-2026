import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  InitResponse,
  PublishPuzzleResponse,
  UserStreak,
} from '../../shared/api';
import { createPuzzlePost } from '../core/post';
import { cleanTitle, loadPuzzle, savePuzzle, validatePuzzle } from '../core/puzzleStore';
import { getDailyDay } from '../core/dailyStore';
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
          }
        : {}),
      // Present on a daily post: which day's board to show (frozen at creation).
      ...(dailyDay != null ? { dailyDay } : {}),
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

/*

post increment_streak - done

check is there a user - done

check the date user:username:streak_date & user:username:streak - done

increment by 1 if today - done

set todays date to today - done

*/

api.post('/increment_streak', async (c) => {
  const user = context.userId;

  if (!user) {
    return c.json<ErrorResponse>(
      {
        status: "error",
        message: "no user",
      },
      400
    )
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const oneDay = 24 * 60 * 60 * 1000;
  const rawDate = await redis.get(`user:${user}:streak_date`);
  let streak = 1

  if (rawDate) { // is there a date?
    const userDate = new Date(rawDate);
    const dateDiff = today.getTime() - userDate.getTime();
    if (dateDiff === oneDay) {
      streak = await redis.incrBy(`user:${user}:streak`, 1);
      console.log("increment user streak");
    } else {
      await redis.set(`user:${user}:streak`, "1");
      console.log("set user streak to 1");
    }
  } else { // no date, must start a streak
    await redis.set(`user:${user}:streak`, "1");
    console.log("no streak exists, set user streak to 1");
  }

  // set users date to todays date
  await redis.set(`user:${user}:streak_date`, today.toISOString());

  return c.json<UserStreak>({
    type: "streak",
    streak: streak.toString()
  });

})

api.get('/fetch_streak', async (c) => {
  const user = context.userId;

  if (!user) {
    return c.json<ErrorResponse>(
      {
        status: "error",
        message: "no user",
      },
      400
    )
  }

  const streak = await redis.get(`user:${user}:streak`)

  if (!streak) {
    return c.json<UserStreak>(
      {
        type: "streak",
        streak: "0"
      }
    )
  } else {
    return c.json<UserStreak>(
      {
        type: "streak",
        streak: streak
      }
    )
  }

})

/*
from the phaser template
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
*/

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
