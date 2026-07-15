import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DeletePuzzleResponse,
  InitResponse,
  MenuStateResponse,
  PublishPuzzleResponse,
  RecordSolveRequest,
  RecordSolveResponse,
  SolveState,
} from '../../shared/api';
import { createPuzzlePost } from '../core/post';
import { syncStreakFlair } from '../core/flair';
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
    // Kept lean on purpose: no reddit.getCurrentUsername() here (a real network round-trip)
    // unless this is a community post that needs it — the client races this call against a
    // short timeout (see primeBootPuzzle / splash.ts's resolveCustom), and a slow /api/init
    // used to lose that race and silently fall back to the generic daily splash / menu.
    const [stored, dailyDay] = await Promise.all([loadPuzzle(postId), getDailyDay(postId)]);

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

// A player's solve streak. Two Redis keys per user:
//   user:<id>:streak    — the current run length (integer, stored as a string)
//   user:<id>:streakDay — the UTC day number (see shared/daily) of their last counted solve
// Days are UTC day numbers so the streak rolls over at the same instant as the daily puzzle for
// everyone, rather than depending on each player's local midnight. Any real solve — a daily of
// either difficulty, or a community puzzle — keeps the run alive; editor previews never count
// (the client doesn't report them).
function streakKeys(userId: string) {
  return { count: `user:${userId}:streak`, day: `user:${userId}:streakDay` } as const;
}

/** The streak that is actually live for `today`: the stored run if the last solve was today or
 *  yesterday, otherwise 0 — a gap of two or more days means the run has lapsed. */
function liveStreak(storedCount: number, lastDay: number | null, today: number): number {
  if (lastDay === null) return 0;
  return lastDay === today || lastDay === today - 1 ? storedCount : 0;
}

/** Read `userId`'s live streak from Redis (see liveStreak); null for a logged-out request. */
async function readLiveStreak(userId: string | undefined, today: number): Promise<number | null> {
  if (!userId) return null;
  const keys = streakKeys(userId);
  const [rawCount, rawDay] = await Promise.all([redis.get(keys.count), redis.get(keys.day)]);
  return liveStreak(
    rawCount ? parseInt(rawCount, 10) : 0,
    rawDay != null ? parseInt(rawDay, 10) : null,
    today
  );
}

// Who has solved which puzzle, one Redis hash of userIds per puzzle:
//   solvers:daily:<day>:<difficulty> — a frozen daily board (shared by every post of that day)
//   solvers:post:<postId>            — a community-puzzle post
// hSetNX gives an atomic "first time for this player?" test, hLen the distinct-player count
// shown on the menu buttons — replays can never inflate it.
function dailySolversKey(day: number, difficulty: 'easy' | 'hard'): string {
  return `solvers:daily:${day}:${difficulty}`;
}

function postSolversKey(postId: string): string {
  return `solvers:post:${postId}`;
}

/** One puzzle's SolveState: distinct-solver count plus whether `userId` is among them. */
async function solveState(key: string, userId: string | undefined): Promise<SolveState> {
  const [solvers, mine] = await Promise.all([
    redis.hLen(key),
    userId ? redis.hGet(key, userId) : Promise.resolve(undefined),
  ]);
  return { solved: mine !== undefined, solvers };
}

/** The RecordSolveRequest from an untrusted body, or null if it isn't one. */
function parseSolveTarget(body: unknown): RecordSolveRequest | null {
  const { kind, difficulty } = (body ?? {}) as { kind?: unknown; difficulty?: unknown };
  if (kind === 'custom') return { kind: 'custom' };
  if (kind === 'daily' && (difficulty === 'easy' || difficulty === 'hard')) {
    return { kind: 'daily', difficulty };
  }
  return null;
}

/** Record a win: mark this player as a solver of the puzzle, extend (or start) their streak,
 *  and refresh their streak flair. Called fire-and-forget by the win screen — replays of an
 *  already-counted day or an already-solved board are no-ops on both counters. */
api.post('/record_solve', async (c) => {
  const user = context.userId;
  const { postId } = context;
  if (!user) {
    return c.json<ErrorResponse>({ status: 'error', message: 'No logged-in user.' }, 401);
  }
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required.' }, 400);
  }

  const target = parseSolveTarget(await c.req.json().catch(() => null));
  if (!target) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid solve payload.' }, 400);
  }

  const today = utcDayNumber();
  const solversKey =
    target.kind === 'custom'
      ? postSolversKey(postId)
      : // A daily post records against its FROZEN day, so solving a historical daily post
        // counts its own board — not today's (untracked/legacy posts fall back to today).
        dailySolversKey((await getDailyDay(postId)) ?? today, target.difficulty);

  // Membership write first (atomic first-solve test), then the count reflects this solve.
  const newSolve = (await redis.hSetNX(solversKey, user, today.toString())) === 1;
  const solvers = await redis.hLen(solversKey);

  // The streak extends at most once per UTC day, whatever was solved.
  const keys = streakKeys(user);
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

  // Best-effort by design (see core/flair) — a flair hiccup never fails the solve.
  await syncStreakFlair(user, streak);

  return c.json<RecordSolveResponse>({ type: 'solve', streak, solvers, newSolve });
});

/** Everything the menu decorates itself with, in one request: the player's live streak plus
 *  the solve state of whatever this post offers (the daily pair, or one community puzzle).
 *  Read-only, and works logged-out — solver counts are global, `solved` just stays false. */
api.get('/menu_state', async (c) => {
  const user = context.userId;
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required.' }, 400);
  }

  const today = utcDayNumber();
  const stored = await loadPuzzle(postId);

  if (stored) {
    // Community-puzzle post: one board, one solver hash.
    const [custom, streak] = await Promise.all([
      solveState(postSolversKey(postId), user),
      readLiveStreak(user, today),
    ]);
    return c.json<MenuStateResponse>({ type: 'menu_state', streak, custom });
  }

  // Daily post: both difficulties of this post's frozen day (see record_solve).
  const day = (await getDailyDay(postId)) ?? today;
  const [easy, hard, streak] = await Promise.all([
    solveState(dailySolversKey(day, 'easy'), user),
    solveState(dailySolversKey(day, 'hard'), user),
    readLiveStreak(user, today),
  ]);
  return c.json<MenuStateResponse>({ type: 'menu_state', streak, daily: { easy, hard } });
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
