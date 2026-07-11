import { redis } from '@devvit/web/server';
import type { LinkType, Puzzle } from '../../shared/puzzle';

/** Redis key for the puzzle attached to a given post. */
const puzzleKey = (postId: string) => `puzzle:${postId}`;

const LINK_TYPES: readonly LinkType[] = [
  'synonym',
  'antonym',
  'hypernym',
  'anagram',
  'meronym',
  'lettersubset',
  'sequence',
  'rhyme',
];

// Keep user-created puzzles within sane bounds so a single post can't store megabytes or
// build a graph the client can't lay out.
const MAX_WORDS = 8;
const MAX_LINKS = 12;
const MAX_WORD_LEN = 16;
const MAX_TITLE_LEN = 100;

export type ValidationResult =
  | { ok: true; puzzle: Puzzle }
  | { ok: false; message: string };

/**
 * Validate an untrusted puzzle payload into a clean `Puzzle`. Structural only — it does
 * NOT check that a link is *semantically* true (that RANGE really is an anagram of ANGER);
 * that's the creator's call. It guarantees the client can render it without crashing:
 * unique non-empty word ids, in-bounds sizes, links referencing real words, and at least
 * one hidden word (otherwise there's nothing to solve).
 */
export function validatePuzzle(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: 'Puzzle must be an object.' };
  }
  const raw = input as { words?: unknown; links?: unknown };
  if (!Array.isArray(raw.words) || !Array.isArray(raw.links)) {
    return { ok: false, message: 'Puzzle needs a words array and a links array.' };
  }
  if (raw.words.length < 2) return { ok: false, message: 'Add at least two words.' };
  if (raw.words.length > MAX_WORDS) {
    return { ok: false, message: `Too many words (max ${MAX_WORDS}).` };
  }
  if (raw.links.length < 1) return { ok: false, message: 'Add at least one link between words.' };
  if (raw.links.length > MAX_LINKS) {
    return { ok: false, message: `Too many links (max ${MAX_LINKS}).` };
  }

  const words: Puzzle['words'] = [];
  const ids = new Set<string>();
  let hiddenCount = 0;
  for (const w of raw.words) {
    if (typeof w !== 'object' || w === null) {
      return { ok: false, message: 'Each word must be an object.' };
    }
    const word = w as { id?: unknown; text?: unknown; hidden?: unknown };
    if (typeof word.id !== 'string' || word.id.length === 0) {
      return { ok: false, message: 'Each word needs an id.' };
    }
    if (ids.has(word.id)) return { ok: false, message: `Duplicate word id "${word.id}".` };
    const text = typeof word.text === 'string' ? word.text.trim().toUpperCase() : '';
    if (text.length === 0) return { ok: false, message: 'Every word needs some text.' };
    if (text.length > MAX_WORD_LEN) {
      return { ok: false, message: `"${text}" is too long (max ${MAX_WORD_LEN} letters).` };
    }
    if (!/^[A-Z]+$/.test(text)) {
      return { ok: false, message: `"${text}" must be letters only.` };
    }
    ids.add(word.id);
    const hidden = word.hidden === true;
    if (hidden) hiddenCount++;
    words.push(hidden ? { id: word.id, text, hidden: true } : { id: word.id, text });
  }
  if (hiddenCount === 0) {
    return { ok: false, message: 'Mark at least one word as hidden — that\'s the answer to solve.' };
  }

  const links: Puzzle['links'] = [];
  for (const l of raw.links) {
    if (typeof l !== 'object' || l === null) {
      return { ok: false, message: 'Each link must be an object.' };
    }
    const link = l as { type?: unknown; from?: unknown; to?: unknown };
    if (typeof link.type !== 'string' || !LINK_TYPES.includes(link.type as LinkType)) {
      return { ok: false, message: 'Each link needs a valid type.' };
    }
    if (typeof link.from !== 'string' || typeof link.to !== 'string') {
      return { ok: false, message: 'Each link needs two words.' };
    }
    if (link.from === link.to) return { ok: false, message: 'A link must join two different words.' };
    if (!ids.has(link.from) || !ids.has(link.to)) {
      return { ok: false, message: 'A link points at a word that no longer exists.' };
    }
    links.push({ type: link.type as LinkType, from: link.from, to: link.to });
  }

  // Every word must be touched by at least one link, or it floats unconnected.
  const touched = new Set<string>();
  for (const link of links) {
    touched.add(link.from);
    touched.add(link.to);
  }
  for (const id of ids) {
    if (!touched.has(id)) return { ok: false, message: 'Every word must be part of at least one link.' };
  }

  return { ok: true, puzzle: { words, links } };
}

/** Trim + clamp a user-supplied title, or fall back to a default. */
export function cleanTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t.length === 0) return 'A WordFish puzzle';
  return t.slice(0, MAX_TITLE_LEN);
}

export type StoredPuzzle = { puzzle: Puzzle; title: string; author: string };

export async function savePuzzle(
  postId: string,
  puzzle: Puzzle,
  title: string,
  author: string
): Promise<void> {
  await redis.set(puzzleKey(postId), JSON.stringify({ puzzle, title, author }));
}

export async function loadPuzzle(postId: string): Promise<StoredPuzzle | null> {
  const raw = await redis.get(puzzleKey(postId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPuzzle>;
    if (parsed && parsed.puzzle && parsed.title) {
      return { puzzle: parsed.puzzle, title: parsed.title, author: parsed.author ?? 'someone' };
    }
    return null;
  } catch {
    return null;
  }
}
