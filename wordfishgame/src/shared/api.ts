import type { Puzzle } from "./puzzle";

export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
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

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
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
