import { media, redis } from '@devvit/web/server';

/**
 * The link-preview (OpenGraph) image shown when a WordFish post is unfurled outside Reddit
 * (Discord, Slack, old.reddit, etc). Without this, custom posts fall back to Reddit's generic
 * placeholder. Source PNG lives in the repo and mirrors the splash screen's Memphis look;
 * see assets/share-image.png (a static capture of splash.ts's rendering).
 */
const SOURCE_URL =
  'https://raw.githubusercontent.com/Oliver-Malkin/Reddit-Hack-2026/main/wordfishgame/assets/share-image.png';
const CACHE_KEY = 'shareImageUrl';

/** Reddit's media host only needs to be given the source URL once — the resulting
 *  Reddit-hosted URL is cached in Redis and reused for every post after that. */
export async function getShareImageUrl(): Promise<string | undefined> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return cached;

  try {
    const { mediaUrl } = await media.upload({ url: SOURCE_URL, type: 'image' });
    await redis.set(CACHE_KEY, mediaUrl);
    return mediaUrl;
  } catch (err) {
    console.error('Failed to upload share image:', err);
    return undefined;
  }
}
