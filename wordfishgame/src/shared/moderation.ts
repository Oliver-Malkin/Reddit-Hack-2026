/**
 * Content moderation for user-created puzzles.
 *
 * Policy (chosen deliberately): hard-block only a small curated set of unambiguous hate
 * slurs. Ordinary profanity and words with innocent alternate meanings are ALLOWED —
 * upvotes sort quality, and most players are adults. This keeps creative freedom while
 * drawing a clear line at genuine hate speech.
 *
 * Matching is whole-word (token) only, so an innocent word that merely CONTAINS a banned
 * sequence isn't caught (the classic "Scunthorpe problem"). Plurals are handled by also
 * testing the token with a trailing "S" removed.
 *
 * This list is a maintained seed — moderators should extend it. It is intentionally short
 * and limited to unambiguous slurs; add terms as needed for your community.
 */

// Uppercase, letters only. Kept short on purpose — extend from a maintained word list.
const BLOCKED_TERMS: readonly string[] = [
  'NIGGER',
  'NIGGA',
  'FAGGOT',
  'FAG',
  'KIKE',
  'SPIC',
  'CHINK',
  'GOOK',
  'WETBACK',
  'TRANNY',
  'RETARD',
  'COON',
  'DYKE',
  'PAKI',
];

const BLOCKED = new Set(BLOCKED_TERMS);

/** Split text into uppercase alphabetic tokens (anything non-letter is a separator). */
function tokenize(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
}

/**
 * Returns the first blocked term found across the given texts (puzzle words + title), or
 * null if the content is clear. Case-insensitive, whole-word, plural-aware.
 */
export function findBlockedTerm(...texts: string[]): string | null {
  for (const text of texts) {
    for (const token of tokenize(text)) {
      const singular = token.endsWith('S') ? token.slice(0, -1) : token;
      if (BLOCKED.has(token) || BLOCKED.has(singular)) return token;
    }
  }
  return null;
}
