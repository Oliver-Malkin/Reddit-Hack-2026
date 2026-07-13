import { Hono } from 'hono';
import { context } from '@devvit/web/server';
import { publishDailyPost } from '../core/post';

export const scheduler = new Hono();

/**
 * Fired by the `daily-post` cron task (00:00 UTC daily — see devvit.json) to roll the daily:
 * publish today's post, pin it as the announcement, and unpin yesterday's. Devvit POSTs these
 * scheduler endpoints with a JSON body and expects a JSON response.
 */
scheduler.post('/daily-post', async (c) => {
  try {
    const post = await publishDailyPost();
    return c.json({ status: 'success', postId: post.id }, 200);
  } catch (error) {
    console.error(`Error running daily-post task in ${context.subredditName}: ${error}`);
    return c.json({ status: 'error', message: 'Failed to publish daily post' }, 500);
  }
});
