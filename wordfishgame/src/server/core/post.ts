import { reddit } from '@devvit/web/server';

export const createPost = async () => {
  return await reddit.submitCustomPost({
    title: 'WordFish — a daily word game',
  });
};

/** Create a Reddit post for a user-created puzzle. The puzzle JSON itself is stored in
 *  Redis keyed by the returned post id (see puzzleStore); opening the post loads it. */
export const createPuzzlePost = async (title: string) => {
  return await reddit.submitCustomPost({
    title: `WordFish: ${title}`,
  });
};
