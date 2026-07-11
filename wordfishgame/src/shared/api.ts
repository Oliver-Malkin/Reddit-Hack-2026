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
