import { media, redis } from '@devvit/web/server';

/**
 * The link-preview (OpenGraph) image shown when a WordFish post is unfurled outside Reddit
 * (Discord, Slack, old.reddit, etc). Without this, custom posts fall back to Reddit's generic
 * placeholder. Source PNG lives in the repo and mirrors the splash screen's Memphis look;
 * see assets/share-image.png (a static capture of splash.ts's rendering).
 */
// Pinned to a commit so the source is immutable — bump this hash whenever the asset changes
// (the cache key below is derived from the URL, so a new hash auto-re-uploads rather than
// serving the stale Reddit-hosted copy forever). This points at the dateless share card; an
// earlier hash pinned a capture with "MONDAY 13 JULY" baked in, which then showed on every
// post's link unfurl.
const SOURCE_URL =
  'https://raw.githubusercontent.com/Oliver-Malkin/Reddit-Hack-2026/cce2720cc3563cc87f3205c3b079a9b4d41ba225/wordfishgame/assets/share-image.png';
// Keyed by the source URL so changing SOURCE_URL misses the cache and re-uploads — the old
// entry just goes stale and unused. A fixed key would pin the first-ever upload for good.
const CACHE_KEY = `shareImageUrl:${SOURCE_URL}`;

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
