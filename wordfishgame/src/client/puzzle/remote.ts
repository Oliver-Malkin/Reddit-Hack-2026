/** Thin client for the game's server API. Every call is best-effort: under the local
 *  `vite src/client` preview there is no server, so failures resolve to a safe result
 *  rather than throwing — the game stays fully playable offline. */

import type { Puzzle } from './types';
import type { DeletePuzzleResponse, InitResponse, PublishPuzzleResponse } from '../../shared/api';

/** A custom puzzle attached to the current post, if this post is a user-created one. */
export type CustomPuzzle = { puzzle: Puzzle; title: string; author: string; url: string };

// The UTC day this (daily) post was frozen to, captured from /api/init at boot. Null on a
// custom-puzzle post, an untracked/legacy daily, or offline — the client then falls back to
// the live UTC day (see puzzles.puzzleForDifficulty).
let bootDailyDay: number | null = null;

/** The frozen UTC day for this daily post, or null. Valid after boot (see primeBootPuzzle). */
export function getBootDailyDay(): number | null {
  return bootDailyDay;
}

// That day's FROZEN easy/hard puzzles (see server/core/dailyStore), captured from /api/init at
// boot. Null on a custom-puzzle post, offline, or (very briefly, historically) a daily whose
// freeze hasn't been backfilled yet — the client then falls back to recomputing from the live
// bank (see puzzles.puzzleForDifficulty), which is only wrong if the bank has since changed.
let bootDailyPuzzles: { easy: Puzzle; hard: Puzzle } | null = null;

/** This daily post's frozen easy/hard puzzles, or null. Valid after boot. */
export function getBootDailyPuzzles(): { easy: Puzzle; hard: Puzzle } | null {
  return bootDailyPuzzles;
}

// Whether the requesting user is this community puzzle's own creator (server-checked — see
// routes/api.ts). Always false on the daily post. Valid after boot (see primeBootPuzzle).
let bootIsOwnPuzzle = false;

/** True when this post is a community puzzle created by the current user, so the menu can
 *  offer a "delete my puzzle" control. Valid after boot. */
export function getBootIsOwnPuzzle(): boolean {
  return bootIsOwnPuzzle;
}

/** Fetch /api/init, aborting (and returning null) after `timeoutMs` rather than hanging
 *  forever against a slow/absent server. Returns the custom puzzle for this post, or null
 *  (daily / offline / timed out), and as a side effect records the daily-day freeze (read
 *  via getBootDailyDay). Cancelling the actual request on timeout (rather than just racing
 *  a separate timer and discarding whichever result arrives second) means a slow-but-alive
 *  server can't have its eventual, correct answer silently thrown away underneath it. */
export async function fetchCustomPuzzle(timeoutMs = 4000): Promise<CustomPuzzle | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/init', { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<InitResponse>;
    if (typeof data?.dailyDay === 'number') bootDailyDay = data.dailyDay;
    if (data?.dailyPuzzles) bootDailyPuzzles = data.dailyPuzzles;
    bootIsOwnPuzzle = data?.isOwnPuzzle === true;
    if (data && data.puzzle) {
      return {
        puzzle: data.puzzle,
        title: data.puzzleTitle ?? 'A WordFish puzzle',
        author: data.puzzleAuthor ?? 'someone',
        url: data.postUrl ?? '',
      };
    }
    return null;
  } catch {
    return null; // no server (local preview), offline, or timed out — just play the daily
  } finally {
    window.clearTimeout(timer);
  }
}

// The custom puzzle this post opened with, resolved once at boot (see primeBootPuzzle) so
// scenes can read it synchronously and decide the opening screen without a menu flash.
let bootPuzzle: CustomPuzzle | null = null;

/** The custom puzzle for this post, or null on the daily / offline. Valid after boot. */
export function getBootPuzzle(): CustomPuzzle | null {
  return bootPuzzle;
}

/**
 * Read a one-off puzzle straight out of the URL: `?previewPuzzle=<encodeURIComponent(JSON)>`.
 * Used by the puzzlegen review tool (see scripts/puzzlegen/review.html) so a curator can jump
 * from a puzzle's chain-of-text preview straight into the real rendered board — no server, no
 * menu, no daily-puzzle plumbing. Malformed/missing input just returns null (falls through to
 * the normal boot flow) rather than throwing.
 */
export function getPreviewPuzzleFromUrl(): Puzzle | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('previewPuzzle');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Puzzle>;
    if (!parsed || !Array.isArray(parsed.words) || !Array.isArray(parsed.links)) return null;
    return parsed as Puzzle;
  } catch {
    return null;
  }
}

/** A demo custom puzzle for local testing (no server): open with `?demoCustom=1`. */
const DEMO_BOOT_PUZZLE: CustomPuzzle = {
  title: 'Meteor Shower',
  author: 'demo_author',
  url: 'https://www.reddit.com/r/wordfishgame',
  puzzle: {
    words: [
      { id: 'w1', text: 'METEOR' },
      { id: 'w2', text: 'REMOTE', hidden: true },
      { id: 'w3', text: 'DISTANT' },
    ],
    links: [
      { type: 'anagram', from: 'w1', to: 'w2' },
      { type: 'synonym', from: 'w2', to: 'w3' },
    ],
  },
};

/** Resolve the post's custom puzzle once, before the game boots. Races the network against a
 *  short timeout so a slow/absent server can't stall the splash. `?demoCustom=1` forces the
 *  demo puzzle so the intro splash is testable in the local preview. */
export async function primeBootPuzzle(): Promise<void> {
  try {
    if (new URLSearchParams(window.location.search).get('demoCustom')) {
      bootPuzzle = DEMO_BOOT_PUZZLE;
      return;
    }
  } catch {
    /* no search params in some webviews — fall through to the fetch */
  }
  bootPuzzle = await fetchCustomPuzzle();
}

export type PublishResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/** Publish a puzzle as a Reddit post. On success the caller navigates to `url`. */
export async function publishPuzzle(title: string, puzzle: Puzzle): Promise<PublishResult> {
  try {
    const res = await fetch('/api/puzzles/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, puzzle }),
    });
    const data = (await res.json().catch(() => null)) as
      | PublishPuzzleResponse
      | { status: 'error'; message: string }
      | null;
    if (res.ok && data && 'url' in data) {
      return { ok: true, url: data.url };
    }
    const message =
      data && 'message' in data && data.message
        ? data.message
        : 'Could not publish. Are you running inside Reddit?';
    return { ok: false, message };
  } catch {
    return {
      ok: false,
      message: 'No connection to Reddit. Publishing works once deployed — use Preview to test.',
    };
  }
}

export type DeleteResult =
  | { ok: true; subredditUrl: string }
  | { ok: false; message: string };

/** Delete this post's own community puzzle. Server-side re-checks that the requester is really
 *  its creator (see routes/api.ts) — this is not the only gate. On success the caller should
 *  navigate away, since this post is now gone. */
export async function deleteOwnPuzzle(): Promise<DeleteResult> {
  try {
    const res = await fetch('/api/puzzles/delete', { method: 'POST' });
    const data = (await res.json().catch(() => null)) as
      | DeletePuzzleResponse
      | { status: 'error'; message: string }
      | null;
    if (res.ok && data && 'subredditUrl' in data) {
      return { ok: true, subredditUrl: data.subredditUrl };
    }
    const message =
      data && 'message' in data && data.message ? data.message : 'Could not delete the puzzle.';
    return { ok: false, message };
  } catch {
    return { ok: false, message: 'No connection to Reddit. Try again once deployed.' };
  }
}

/** Navigate the Reddit webview to a post URL (no-op outside Devvit). */
export async function navigateToPost(url: string): Promise<void> {
  try {
    const mod = await import('@devvit/web/client');
    mod.navigateTo(url);
  } catch {
    /* not inside Devvit (local preview) — nothing to navigate */
  }
}
