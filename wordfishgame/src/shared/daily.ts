/**
 * The daily rolls over at 00:00 UTC so everyone worldwide flips to the next puzzle at the same
 * instant. Each daily Reddit post is created by the scheduler at that moment and FROZEN to the
 * day it was made (see server/core/dailyStore) — so opening a historical daily post later still
 * serves that day's board, and its date label matches, rather than jumping to whatever today is.
 */

/** Days since the Unix epoch, in UTC. Server and client compute this identically. */
export function utcDayNumber(atMs: number = Date.now()): number {
  return Math.floor(atMs / 86_400_000);
}

/** Format a UTC day number as e.g. "MONDAY 13 JULY" — the label for that day's daily. Forced
 *  to the UTC calendar day so the label always names the same day the puzzle rolled on. */
export function utcDayLabel(day: number): string {
  try {
    return new Date(day * 86_400_000)
      .toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      })
      .toUpperCase();
  } catch {
    return 'TODAY';
  }
}
