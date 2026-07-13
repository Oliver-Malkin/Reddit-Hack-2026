import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  PublishPuzzleResponse,
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
    const [count, username, stored, dailyDay] = await Promise.all([
      redis.get('count'),
      reddit.getCurrentUsername(),
      loadPuzzle(postId),
      getDailyDay(postId),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? 'anonymous',
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
