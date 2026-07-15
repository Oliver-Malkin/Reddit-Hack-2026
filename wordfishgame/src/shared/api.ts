import type { Puzzle } from "./puzzle";

export type InitResponse = {
  type: "init";
  postId: string;
  /** Present when this post is a user-created puzzle — the client plays it instead of
   *  the daily. Absent on the default / daily post. */
  puzzle?: Puzzle;
  /** Human title of a custom puzzle post (for the intro splash / share text). */
  puzzleTitle?: string;
  /** Reddit username of the puzzle's creator (for the intro splash "by u/…"). */
  puzzleAuthor?: string;
  /** Full reddit.com URL of this post (custom puzzles only), for the share button. */
  postUrl?: string;
  /** True when the requesting user is this custom puzzle's creator, so the client can offer
   *  a "delete my puzzle" control. Always false/absent on the daily post. Checked server-side
   *  (see routes/api.ts) — never trust a client-supplied claim of authorship. */
  isOwnPuzzle?: boolean;
  /** For a daily post: the UTC day it was frozen to (see shared/daily). The client selects
   *  that day's easy/hard boards and dates the menu label from it, so historical daily posts
   *  keep their own puzzle. Absent on custom-puzzle posts and untracked/legacy posts. */
  dailyDay?: number;
  /** Present on a daily post: that day's FROZEN easy/hard puzzles (see server/core/dailyStore).
   *  The client prefers these over recomputing from the live puzzleBank, so a historical daily
   *  keeps showing what it showed even after the bank is later edited/regenerated. */
  dailyPuzzles?: { easy: Puzzle; hard: Puzzle };
};

/** One puzzle's solve status: whether the requesting user has solved it, and how many
 *  distinct players have. `solvers` is global (logged-out users see it too); `solved` is
 *  always false when there is no logged-in user. */
export type SolveState = {
  solved: boolean;
  solvers: number;
};

/** Everything the menu needs to decorate itself, in one round-trip: the player's streak,
 *  plus per-puzzle solve state — `daily` on a daily post (both difficulties of that post's
 *  frozen day), `custom` on a community-puzzle post. See routes/api.ts. */
export type MenuStateResponse = {
  type: "menu_state";
  /** Consecutive days with a solve — 0 when lapsed/never; null when not logged in. */
  streak: number | null;
  daily?: { easy: SolveState; hard: SolveState };
  custom?: SolveState;
};

/** Client → server: the player just solved a puzzle (never sent for editor previews). */
export type RecordSolveRequest =
  | { kind: "daily"; difficulty: "easy" | "hard" }
  | { kind: "custom" };

export type RecordSolveResponse = {
  type: "solve";
  /** The player's streak after this solve (a replay of an already-counted day is a no-op). */
  streak: number;
  /** Distinct players who have solved this puzzle, including this one. */
  solvers: number;
  /** False when this player had already solved this exact puzzle before. */
  newSolve: boolean;
};

/** Client → server: publish a user-created puzzle as its own Reddit post. */
export type PublishPuzzleRequest = {
  title: string;
  puzzle: Puzzle;
};

export type PublishPuzzleResponse = {
  type: "publish";
  status: "ok";
  postId: string;
  /** Full reddit.com URL of the new post, for navigateTo. */
  url: string;
};

export type ApiErrorResponse = {
  status: "error";
  message: string;
};

/** Client → server: delete a community puzzle post — only the creator may do this. */
export type DeletePuzzleResponse = {
  type: "delete";
  status: "ok";
  /** Where to send the client after deletion, since its own post is now gone. */
  subredditUrl: string;
};
