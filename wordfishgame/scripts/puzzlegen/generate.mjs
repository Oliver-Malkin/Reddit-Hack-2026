/**
 * Daily-puzzle generator. Run with:  npm run generate:puzzles
 *
 * Pipeline:
 *  1. Vocab = top-10k English words by frequency (+ curated sequence words).
 *  2. Relation graph over the vocab (WordNet, CMU rhymes, computed letterplay,
 *     curated sequences) — see graph.mjs for the strict/liberal split.
 *  3. Assemble puzzles in several shapes (difficulty is per-shape, see SHAPE_DIFF):
 *       EASY   path3    known — [hidden] — known
 *              triclue  three knowns all clueing ONE hidden, IRREDUCIBLY (drop any clue and
 *                       the answer is no longer unique — so all three are needed)
 *              anchored path4 plus a third known clueing one of the hiddens
 *       HARD   path4    known — [hidden] — [hidden] — known
 *              diamond  two knowns, each linked to BOTH hiddens (a 4-cycle)
 *              path5    known — [hidden] — [hidden] — [hidden] — known
 *              loop5    path5 closed into a 5-cycle (two knowns, three hiddens round a ring)
 *  4. Every candidate passes a uniqueness check: no other word (or word tuple) in a
 *     ~73k-word lexicon satisfies all the clues at the answers' lengths.
 *  5. Manual vetting via review.html: ACCEPT locks a puzzle into a permanent stockpile
 *     (accepted.json) that every future run includes verbatim, no matter how the
 *     generator or scoring changes later. SKIP and BAN LINK write to rejects.json, which
 *     holds two veto lists: skipped puzzle ids (passed over — that exact puzzle won't
 *     re-emit, nothing declared wrong) and banned links (one bad clue vetoes every future
 *     puzzle built on that relation). A regeneration fills only the slots not already
 *     covered by the accepted stockpile.
 *  6. Selection balances LINK TYPES (rarer relation types are prioritized so all 8
 *     appear in roughly equal numbers), dedupes by word stem, caps each hard shape, then
 *     places the accepted stockpile first (fixed, append-only order — never reshuffled,
 *     so a shipped puzzle's day never changes) followed by freshly-picked filler
 *     (shuffled deterministically, among itself only), then emits:
 *       - src/shared/puzzleBank.ts         (typed, committed, shipped to client + server)
 *       - scripts/puzzlegen/report.txt     (plain-text summary — NOT committed, spoilers)
 *       - scripts/puzzlegen/review.html    (interactive vetting page — NOT committed)
 *     accepted.json / report.txt / review.html are gitignored: they hold full puzzle
 *     answers and have no reason to ever reach a public repo or the deployed app (the
 *     Devvit build only bundles src/client — scripts/puzzlegen is never part of it).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWordNet } from './wordnet.mjs';
import { buildGraph, parseCmu, sharesStem } from './graph.mjs';
import { SEQUENCE_PAIRS } from './sequences.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const SEED = 0x5eedf15b; // change to reroll the bank
// How many FRESH (not-yet-accepted) puzzles to surface per difficulty each run, on top of
// the accepted stockpile — the review pool. Independent of stockpile size, so the number
// of new puzzles to vet stays constant as accepted.json grows (it never shrinks to zero).
const FRESH_TARGET = 100; // per difficulty
// How many of each shape the FRESH pool may hold, at most (they compete on score/type
// balance below the caps; shortfalls in one shape are filled by the others). Each set sums
// above FRESH_TARGET so the target, not the caps, is the binding limit — the caps just stop
// the most numerous shape (path3 / path4) from crowding out the rarer ones you want to vet.
const EASY_SHAPE_QUOTA = { path3: 65, triclue: 30, anchored: 30 };
const HARD_SHAPE_QUOTA = { path4: 50, diamond: 20, path5: 22, loop5: 22 };
// New/rare shapes are picked FIRST (before the abundant path3/path4/path5), so those can't
// eat the whole freshTarget before enough of them land in the review batch.
const FORCE_FIRST_SHAPES = new Set(['triclue', 'loop5']);
// Irreducible triclues exist only in the low tens, and share common clue words, so the
// ordinary "no two fresh puzzles share a word-stem" guard would suppress nearly all of
// them. Exempting them from it surfaces as many as exist; they may share a word with
// another fresh puzzle, which is fine for vetting. (loop5 is force-first but NOT exempt —
// keeping its stem guard avoids near-duplicate rings from the same rhyme family.)
const STEM_EXEMPT_SHAPES = new Set(['triclue']);

// Rank ceilings (google-10k index): how common words must be for each slot.
const EASY_HIDDEN_MAX_RANK = 3500;
const EASY_KNOWN_MAX_RANK = 4500;
const HARD_HIDDEN_MAX_RANK = 6500;
const HARD_KNOWN_MAX_RANK = 5500;
const SEQ_WORD_RANK = 4000; // rank assigned to curated sequence words missing from the list
// A triclue clue must individually admit at least this many lexicon words (its "spread"),
// so no single clue narrows the answer much — the solve has to combine all three. Lower to
// find more triclues, raise to make each clue vaguer (harder). See pickTriclue.
const MIN_TRICLUE_SPREAD = 8;

const LINK_TYPE_LIST = ['synonym', 'antonym', 'hypernym', 'anagram', 'meronym', 'lettersubset', 'sequence', 'rhyme'];
const MEANING = new Set(['synonym', 'antonym', 'hypernym', 'meronym', 'sequence']);
const LABELS = {
  synonym: 'same as',
  antonym: 'opposite of',
  anagram: 'anagram of',
  rhyme: 'rhymes with',
  hypernym: 'includes',
  meronym: 'part of',
  lettersubset: 'letters hide in',
  sequence: 'becomes',
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rnd) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/** Stable content id for a puzzle — survives regeneration, keys rejects.json. */
function puzzleId(puzzle) {
  const canon =
    puzzle.words.map((w) => `${w.text}${w.hidden ? '?' : ''}`).join(',') +
    '|' +
    puzzle.links.map((l) => `${l.type}:${l.from}>${l.to}`).join(',');
  let h = 5381;
  for (let i = 0; i < canon.length; i++) h = (h * 33) ^ canon.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Direction-insensitive key for a single link between two word TEXTS (not slot ids).
 *  "SOURCE anagram COURSE" and "COURSE anagram SOURCE" collapse to the same key, so a
 *  ban lands regardless of which of the pair the generator later chooses to hide. */
function linkKey(type, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${type}|${x}~${y}`;
}

// ---------- load data ----------

console.log('loading datasets…');
const freqList = readFileSync(join(HERE, 'data', 'google-10000.txt'), 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);

const WEB_JUNK = ['www', 'com', 'org', 'net', 'edu', 'gov', 'mil', 'htm', 'html', 'php', 'asp', 'gif', 'jpg', 'png', 'ftp', 'url', 'faq', 'usr', 'src', 'img', 'sitemap', 'username', 'login', 'logout', 'admin', 'webmaster', 'homepage', 'ebay', 'yahoo', 'google', 'microsoft', 'paypal', 'walmart', 'adobe', 'nokia', 'sony', 'dell', 'ibm', 'cnet', 'msn', 'aol', 'verizon', 'cisco', 'intel', 'motorola', 'samsung', 'toshiba', 'panasonic', 'toyota', 'honda', 'nissan', 'yamaha', 'ericsson'];
// First names read as cheap answers ("[GARY] is an anagram of GRAY"). Dual-use words
// that are solid common nouns/adjectives (frank, bill, mark, rose, ray, jack…) stay.
const FIRST_NAMES = ['john', 'james', 'david', 'michael', 'paul', 'robert', 'richard', 'thomas', 'peter', 'eric', 'gary', 'steven', 'stephen', 'kevin', 'brian', 'scott', 'jason', 'justin', 'brandon', 'aaron', 'adam', 'alan', 'albert', 'alex', 'andrew', 'anthony', 'barry', 'benjamin', 'bob', 'bobby', 'brad', 'bruce', 'carl', 'charles', 'chris', 'craig', 'dan', 'daniel', 'dave', 'dennis', 'donald', 'doug', 'douglas', 'earl', 'edward', 'eddie', 'eugene', 'fred', 'gerald', 'glen', 'glenn', 'gordon', 'greg', 'harold', 'harry', 'henry', 'howard', 'ian', 'jacob', 'jake', 'jamie', 'jeff', 'jeffrey', 'jeremy', 'jerry', 'jesse', 'jim', 'jimmy', 'joe', 'joel', 'joey', 'jon', 'jonathan', 'jordan', 'joseph', 'josh', 'joshua', 'juan', 'keith', 'kelly', 'ken', 'kenneth', 'kenny', 'kurt', 'kyle', 'larry', 'lawrence', 'lee', 'leon', 'leonard', 'louis', 'luke', 'marc', 'marcus', 'mario', 'martin', 'matt', 'matthew', 'maurice', 'melvin', 'michel', 'miguel', 'mike', 'nathan', 'neil', 'nicholas', 'nick', 'norman', 'oliver', 'oscar', 'patrick', 'pedro', 'perry', 'phil', 'philip', 'phillip', 'ralph', 'randy', 'raymond', 'ricardo', 'rick', 'ricky', 'rob', 'roberto', 'rod', 'roger', 'ron', 'ronald', 'ross', 'roy', 'russell', 'ryan', 'sam', 'samuel', 'sean', 'seth', 'shane', 'shawn', 'sidney', 'simon', 'stanley', 'steve', 'stuart', 'ted', 'terry', 'tim', 'timothy', 'todd', 'tom', 'tommy', 'tony', 'travis', 'tyler', 'victor', 'vincent', 'walter', 'warren', 'wayne', 'mary', 'patricia', 'linda', 'barbara', 'elizabeth', 'jennifer', 'maria', 'susan', 'margaret', 'dorothy', 'lisa', 'nancy', 'karen', 'betty', 'helen', 'sandra', 'donna', 'carol', 'sharon', 'michelle', 'laura', 'sarah', 'kimberly', 'deborah', 'jessica', 'shirley', 'cynthia', 'angela', 'melissa', 'brenda', 'amy', 'anna', 'rebecca', 'kathleen', 'pamela', 'martha', 'debra', 'amanda', 'stephanie', 'carolyn', 'christine', 'marie', 'janet', 'catherine', 'ann', 'anne', 'joyce', 'diane', 'diana', 'alice', 'julie', 'julia', 'heather', 'teresa', 'theresa', 'doris', 'gloria', 'evelyn', 'cheryl', 'katie', 'kathy', 'joan', 'ashley', 'judith', 'judy', 'janice', 'nicole', 'christina', 'beverly', 'denise', 'tammy', 'irene', 'jane', 'lori', 'rachel', 'marilyn', 'andrea', 'kathryn', 'louise', 'sara', 'jacqueline', 'wanda', 'bonnie', 'lois', 'tina', 'phyllis', 'norma', 'paula', 'annie', 'lillian', 'emily', 'robyn', 'kim', 'monica', 'erica', 'nina', 'emma', 'wendy', 'kate', 'karl', 'arthur', 'antonio', 'carlos', 'jose', 'francis', 'frederick', 'gilbert', 'harvey', 'herbert', 'jesus', 'lloyd', 'manuel', 'milton', 'mitchell', 'nelson', 'ramon', 'reginald', 'rodney', 'ruben', 'salvador', 'sergio', 'wallace', 'wesley'];
// Acronyms and words too charged to hang a whimsical clue on.
const SENSITIVE = ['aids', 'hiv', 'nazi', 'rape', 'incest', 'suicide', 'cancer', 'anal', 'sex'];
// Fragments the web corpus thinks are words.
const FRAGMENTS = ['est', 'tel', 'pre', 'perl', 'ext', 'exp', 'sec', 'etc', 'inc', 'ltd', 'dept', 'univ', 'intl', 'misc', 'para', 'proc', 'std', 'var', 'src', 'hist', 'min', 'mon', 'lite', 'anti', 'num', 'util', 'temp', 'config', 'admin', 'info'];
const STOP = new Set([...WEB_JUNK, ...FIRST_NAMES, ...SENSITIVE, ...FRAGMENTS]);

// Pure grammar words make unsatisfying ANSWERS (fine as visible clue words).
const HIDDEN_STOP = new Set(['the', 'there', 'this', 'these', 'those', 'that', 'them', 'then', 'than', 'they', 'their', 'what', 'when', 'which', 'while', 'with', 'from', 'into', 'been', 'have', 'has', 'had', 'was', 'were', 'are', 'also', 'thus', 'does', 'your', 'ours', 'and', 'but', 'for', 'not', 'you']);

const vocabRank = new Map();
freqList.forEach((w, i) => {
  if (/^[a-z]+$/.test(w) && w.length >= 3 && w.length <= 10 && !STOP.has(w) && /[aeiouy]/.test(w)) {
    if (!vocabRank.has(w)) vocabRank.set(w, i);
  }
});
for (const [a, b] of SEQUENCE_PAIRS) {
  if (!vocabRank.has(a) && a.length <= 10) vocabRank.set(a, SEQ_WORD_RANK);
  if (!vocabRank.has(b) && b.length <= 10) vocabRank.set(b, SEQ_WORD_RANK);
}
const rank = (w) => vocabRank.get(w) ?? Infinity;

const wn = loadWordNet();

const cmu = parseCmu(readFileSync(join(HERE, 'data', 'cmudict.dict'), 'utf8'));

// Validation lexicon: every word a solver might legitimately answer with — the uniqueness
// check REJECTS a puzzle if any lexicon word (beyond the intended answer) fits all its clues,
// so recall matters far more than precision here. Three sources:
//   - vocab (google-10k) — the puzzle-answer vocabulary;
//   - every single-word WordNet lemma;
//   - every CMU pronouncing-dictionary word.
// The last is essential: google-10k and WordNet lemmas are mostly BASE forms, so common
// inflections (LAYS, EMBARKS, SPARKS) were absent — and a slot whose only lexicon match was
// the intended answer looked "unique" even when an unlisted inflection also fit (e.g. PAYS
// passed while LAYS, equally valid, was invisible). CMU carries those inflected forms.
const vLex = new Set(vocabRank.keys());
for (const [lemmaFile] of wn.senses) {
  const lemma = lemmaFile.slice(0, lemmaFile.indexOf('|'));
  if (/^[a-z]+$/.test(lemma) && lemma.length >= 3 && lemma.length <= 12) vLex.add(lemma);
}
for (const w of cmu.keys.keys()) {
  if (w.length >= 3 && w.length <= 12 && /[aeiouy]/.test(w)) vLex.add(w);
}

console.log(`vocab ${vocabRank.size}, lexicon ${vLex.size} — building graph…`);
const graph = buildGraph({ wn, vocabRank, vLex, cmu, sequencePairs: SEQUENCE_PAIRS });
{
  const counts = new Map();
  for (const e of graph.strictEdges) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  console.log('strict edges:', Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])));
}

// Vetting decisions from review.html. Two independent veto lists:
//   skips — exact-puzzle ids the vetter passed on (too easy/boring/etc.); nothing is
//           declared wrong, that one puzzle simply won't be re-emitted.
//   links — a single {type, words:[a,b]} relation banned outright. Usually it's one bad
//           clue, not the whole puzzle, that blocks acceptance, so a banned link vetoes
//           EVERY future puzzle built on that relation (whichever word it hides).
// Back-compat: an older rejects.json was a bare array of ids, or {ids,...}; both read as skips.
const rejectsPath = join(HERE, 'rejects.json');
const rejectsRaw = existsSync(rejectsPath) ? JSON.parse(readFileSync(rejectsPath, 'utf8')) : null;
const rejectsData = Array.isArray(rejectsRaw)
  ? { skips: rejectsRaw, links: [] }
  : { skips: rejectsRaw?.skips ?? rejectsRaw?.ids ?? [], links: rejectsRaw?.links ?? [] };
const skips = new Set(rejectsData.skips);
const bannedLinks = new Set(rejectsData.links.map((l) => linkKey(l.type, l.words[0], l.words[1])));
if (skips.size || bannedLinks.size) {
  console.log(`loaded ${skips.size} skipped id(s), ${bannedLinks.size} banned link(s)`);
}

/** Every link of a puzzle as a direction-insensitive word-text key (see linkKey). */
function puzzleLinkKeys(puzzle) {
  const text = new Map(puzzle.words.map((w) => [w.id, w.text]));
  return puzzle.links.map((l) => linkKey(l.type, text.get(l.from), text.get(l.to)));
}
const hasBannedLink = (puzzle) =>
  bannedLinks.size > 0 && puzzleLinkKeys(puzzle).some((k) => bannedLinks.has(k));

// Manually approved puzzles (see review.html) — the permanent stockpile. Stored as full
// puzzle objects (not just ids) so they survive changes to the generator/scoring/graph;
// every run includes ALL of them verbatim, on top of whatever fresh slots remain. A
// later skip can retroactively evict a previously accepted puzzle (filtered out below);
// a banned link does NOT — the vetter accepted that puzzle knowing the clue it contains.
const acceptedPath = join(HERE, 'accepted.json');
const acceptedRaw = existsSync(acceptedPath) ? JSON.parse(readFileSync(acceptedPath, 'utf8')) : [];
const accepted = acceptedRaw.filter((a) => !skips.has(a.id));
if (accepted.length > 0) console.log(`loaded ${accepted.length} accepted puzzles from the stockpile`);

// A puzzle's shape is fully determined by (word count, hidden count, link count) — see
// the shape comment at the top of this file for what each combination looks like.
const SHAPE_BY_SIGNATURE = {
  '3|1|2': 'path3',
  '4|1|3': 'triclue',
  '4|2|3': 'path4',
  '4|2|4': 'diamond',
  '5|2|4': 'anchored',
  '5|3|4': 'path5',
  '5|3|5': 'loop5',
};
function deriveShape(puzzle) {
  const hiddenCount = puzzle.words.filter((w) => w.hidden).length;
  return SHAPE_BY_SIGNATURE[`${puzzle.words.length}|${hiddenCount}|${puzzle.links.length}`] ?? 'custom';
}

// Which daily track each shape ships in. The single source of truth: builders route new
// candidates here, and accepted puzzles are re-classified by their shape (so moving a shape
// between difficulties automatically moves every already-accepted puzzle of that shape too).
const SHAPE_DIFF = {
  path3: 'easy',
  triclue: 'easy',
  anchored: 'easy', // moved from hard: the extra anchor gives away too much for a "hard"
  path4: 'hard',
  diamond: 'hard',
  path5: 'hard',
  loop5: 'hard',
};
const diffOfShape = (shape) => SHAPE_DIFF[shape] ?? 'hard';
const stemsOf = (puzzle) => puzzle.words.map((w) => w.text.toLowerCase().slice(0, 4));
const typesOf = (puzzle) => puzzle.links.map((l) => l.type);

/** Turn a stored accepted-stockpile record into a normal bank candidate. */
function acceptedCandidate(a) {
  return {
    puzzle: a.puzzle,
    id: a.id,
    types: typesOf(a.puzzle),
    shape: deriveShape(a.puzzle),
    score: a.score ?? 0,
    stems: stemsOf(a.puzzle),
  };
}
const acceptedIds = new Set(accepted.map((a) => a.id));

// ---------- uniqueness ----------

const otherRole = (role) => (role === 'from' ? 'to' : 'from');

/** Words that could fill a hidden slot of length `len` given one clue edge
 *  {type, other, role} where role is the HIDDEN word's role in the link. */
const clueCandidates = (clue, len) =>
  graph.liberalCandidates(clue.type, clue.other, otherRole(clue.role), len);

/** One hidden slot: must be the only lexicon word satisfying every clue. */
function isUniqueSlot(hidden, clues) {
  let cands = null;
  for (const clue of clues) {
    const set = clueCandidates(clue, hidden.length);
    if (cands === null) {
      cands = new Set(set);
    } else {
      for (const w of cands) if (!set.has(w)) cands.delete(w);
    }
    if (cands.size === 0) return false; // graph asymmetry — shouldn't happen, but be safe
  }
  return cands.size === 1 && cands.has(hidden);
}

/** path4: (h1, h2) must be the only pair satisfying clueA(h1), middle(h1,h2), clueB(h2). */
function isUniquePath4(h1, h2, clueA, middle, clueB) {
  const c1 = clueCandidates(clueA, h1.length);
  const c2 = clueCandidates(clueB, h2.length);
  if (!c1.has(h1) || !c2.has(h2)) return false;
  if (c1.size > 600 || c2.size > 600) return false; // too open-ended to be a fair clue
  let found = 0;
  for (const w1 of c1) {
    if (w1 === clueA.other || w1 === clueB.other) continue;
    for (const w2 of c2) {
      if (w2 === w1 || w2 === clueA.other || w2 === clueB.other) continue;
      const [from, to] = middle.h1Role === 'from' ? [w1, w2] : [w2, w1];
      if (graph.liberalPair(middle.type, from, to)) {
        found++;
        if (found > 1) return false;
      }
    }
  }
  return found === 1;
}

/** path5: (h1, h2, h3) must be the only triple satisfying
 *  clueA(h1), e12(h1,h2), e23(h2,h3), clueB(h3). */
function isUniquePath5(h1, h2, h3, clueA, e12, e23, clueB) {
  const c1 = clueCandidates(clueA, h1.length);
  const c3 = clueCandidates(clueB, h3.length);
  if (!c1.has(h1) || !c3.has(h3)) return false;
  if (c1.size > 80 || c3.size > 80) return false; // keep the joint search tractable
  const knowns = new Set([clueA.other, clueB.other]);
  let found = 0;
  for (const w1 of c1) {
    if (knowns.has(w1)) continue;
    // valid middles reachable from w1 via the h1-h2 link
    const m1 = graph.liberalCandidates(e12.type, w1, e12.h1Role, h2.length);
    if (m1.size === 0) continue;
    for (const w3 of c3) {
      if (w3 === w1 || knowns.has(w3)) continue;
      const m3 = graph.liberalCandidates(e23.type, w3, e23.h3Role, h2.length);
      const [small, big] = m1.size <= m3.size ? [m1, m3] : [m3, m1];
      for (const m of small) {
        if (!big.has(m) || m === w1 || m === w3 || knowns.has(m)) continue;
        found++;
        if (found > 1) return false;
      }
    }
  }
  return found === 1;
}

// ---------- scoring ----------

function scorePuzzle(words, types, shape = 'path3') {
  let score = 0;
  const uniqueTypes = new Set(types);
  if (uniqueTypes.size === types.length) score += 2; // all links different
  if (types.some((t) => MEANING.has(t)) && types.some((t) => !MEANING.has(t))) score += 4; // meaning × letterplay is where the aha lives
  for (const t of types) {
    if (t === 'anagram') score += 1;
    if (t === 'sequence') score += 1.25;
    if (t === 'lettersubset') score += 0.75;
  }
  const avgRank = words.reduce((s, w) => s + rank(w), 0) / words.length;
  score -= avgRank / 2000;
  for (const w of words) {
    if (w.length >= 4 && w.length <= 7) score += 0.25;
  }
  if (shape === 'diamond' || shape === 'path5' || shape === 'loop5') score += 1; // novelty
  if (shape === 'anchored') score += 0.5;
  if (shape === 'triclue') score += 3; // irreducible triclues are rare — prioritize into the batch
  return score;
}

// ---------- candidate assembly ----------

/** Link ends in graph edge order: hiddenRole is the hidden word's role in the link. */
const link = (type, hiddenId, otherId, hiddenRole) =>
  hiddenRole === 'from' ? { type, from: hiddenId, to: otherId } : { type, from: otherId, to: hiddenId };

const word = (id, text, hidden = false) =>
  hidden ? { id, text: text.toUpperCase(), hidden: true } : { id, text: text.toUpperCase() };

/** Wrap an emitted puzzle into a bank candidate (skipping ones vetoed or already
 *  locked into the accepted stockpile — no point generating a duplicate of either). */
function candidate(puzzle, lowerWords, types, shape, score) {
  const id = puzzleId(puzzle);
  if (skips.has(id) || acceptedIds.has(id)) return null;
  if (hasBannedLink(puzzle)) return null;
  return { puzzle, id, types, shape, score, stems: lowerWords.map((w) => w.slice(0, 4)) };
}

const hiddenOk = (w, maxRank, maxLen = 9) =>
  rank(w) <= maxRank && w.length >= 3 && w.length <= maxLen && !HIDDEN_STOP.has(w);

/** A hidden word's usable clue edges, sorted by how common the clue word is. */
function clueEdges(hidden, maxKnownRank, exclude = []) {
  return (graph.byWord.get(hidden) ?? [])
    .filter(
      (e) =>
        rank(e.other) <= maxKnownRank &&
        e.other.length <= 10 &&
        !sharesStem(hidden, e.other) &&
        !exclude.includes(e.other) &&
        !exclude.some((x) => sharesStem(x, e.other))
    )
    .sort((a, b) => rank(a.other) - rank(b.other));
}

// Every builder emits into one pool; difficulty routing is by shape (SHAPE_DIFF), so a
// shape's daily track is decided in exactly one place. `candidate()` returns null for a
// vetoed/duplicate puzzle, which pushCandidate simply drops.
const easyCandidates = [];
const hardCandidates = [];
const pushCandidate = (c) => {
  if (!c) return;
  (diffOfShape(c.shape) === 'easy' ? easyCandidates : hardCandidates).push(c);
};

/** Find 3 clue edges forming a "Venn" triclue — the answer is the single word in the
 *  intersection of three individually BROAD clues. Requirements:
 *   - each clue on its own admits many words (spread ≥ MIN_TRICLUE_SPREAD) — so no single
 *     clue (an anagram, or a "hides inside a known" letter clue) nearly gives it away, and
 *     the difficulty comes from combining all three;
 *   - the three together pin it uniquely, yet every 2-of-3 subset stays ambiguous, so each
 *     clue is genuinely load-bearing (irreducible).
 *  Distinct knowns, no stem clash. Rare, so we search combinations. */
function pickTriclue(hidden, pool) {
  const L = hidden.length;
  const loose = pool.filter((e) => clueCandidates(e, L).size >= MIN_TRICLUE_SPREAD).slice(0, 9);
  for (let i = 0; i < loose.length; i++) {
    for (let j = i + 1; j < loose.length; j++) {
      for (let k = j + 1; k < loose.length; k++) {
        const trio = [loose[i], loose[j], loose[k]];
        const [a, b, c] = trio;
        if (a.other === b.other || a.other === c.other || b.other === c.other) continue;
        if (sharesStem(a.other, b.other) || sharesStem(a.other, c.other) || sharesStem(b.other, c.other)) continue;
        // All three needed: unique together, ambiguous with any one removed.
        if (!isUniqueSlot(hidden, trio)) continue;
        if (isUniqueSlot(hidden, [a, b]) || isUniqueSlot(hidden, [a, c]) || isUniqueSlot(hidden, [b, c])) continue;
        return trio;
      }
    }
  }
  return null;
}

// --- EASY (path3, triclue) + the unique (hidden, known, known) triples that diamonds and
//     loops are built from ---

console.log('generating easy + collecting unique triples…');
/** knownPairKey -> [{hidden, e1, e2}] — every hidden uniquely pinned by that pair of
 *  knowns. Two entries under one key with different hiddens = a diamond puzzle. */
const triplesByKnowns = new Map();

for (const [hidden] of vocabRank) {
  if (!hiddenOk(hidden, HARD_HIDDEN_MAX_RANK)) continue;
  const pool = clueEdges(hidden, HARD_KNOWN_MAX_RANK).slice(0, 12);
  if (pool.length < 2) continue;
  let bestEasy = null;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const e1 = pool[i];
      const e2 = pool[j];
      if (e1.other === e2.other || sharesStem(e1.other, e2.other)) continue;
      if (e1.type === e2.type && e1.type === 'rhyme') continue; // two rhyme clues = same sound twice, dull
      if (!isUniqueSlot(hidden, [e1, e2])) continue;

      const key = [e1.other, e2.other].sort().join('|');
      let group = triplesByKnowns.get(key);
      if (!group) triplesByKnowns.set(key, (group = []));
      group.push({ hidden, e1, e2 });

      if (
        hiddenOk(hidden, EASY_HIDDEN_MAX_RANK, 8) &&
        rank(e1.other) <= EASY_KNOWN_MAX_RANK &&
        rank(e2.other) <= EASY_KNOWN_MAX_RANK
      ) {
        const score = scorePuzzle([e1.other, hidden, e2.other], [e1.type, e2.type]);
        if (!bestEasy || score > bestEasy.score) bestEasy = { e1, e2, score };
      }
    }
  }
  if (bestEasy) {
    const { e1, e2, score } = bestEasy;
    const puzzle = {
      words: [word('w0', e1.other), word('w1', hidden, true), word('w2', e2.other)],
      links: [link(e1.type, 'w1', 'w0', e1.role), link(e2.type, 'w1', 'w2', e2.role)],
    };
    pushCandidate(candidate(puzzle, [e1.other, hidden, e2.other], [e1.type, e2.type], 'path3', score));
  }

  // triclue: three easy knowns all clueing this one hidden — three angles pin it fast.
  if (hiddenOk(hidden, EASY_HIDDEN_MAX_RANK, 8)) {
    const easyPool = pool.filter((e) => rank(e.other) <= EASY_KNOWN_MAX_RANK);
    const tri = pickTriclue(hidden, easyPool);
    if (tri) {
      const words = [hidden, tri[0].other, tri[1].other, tri[2].other];
      const types = tri.map((e) => e.type);
      const puzzle = {
        words: [
          word('w0', hidden, true),
          word('w1', tri[0].other),
          word('w2', tri[1].other),
          word('w3', tri[2].other),
        ],
        links: [
          link(tri[0].type, 'w0', 'w1', tri[0].role),
          link(tri[1].type, 'w0', 'w2', tri[1].role),
          link(tri[2].type, 'w0', 'w3', tri[2].role),
        ],
      };
      pushCandidate(candidate(puzzle, words, types, 'triclue', scorePuzzle(words, types, 'triclue')));
    }
  }
}
console.log(`  ${easyCandidates.length} easy candidates, ${triplesByKnowns.size} known-pairs`);

// --- path4 (hard) + anchored variant (easy — routed by shape) ---

console.log('generating path4 + anchored…');
const seenHiddenPairs = new Set();
for (const middleEdge of graph.strictEdges) {
  for (const flip of [false, true]) {
    const h1 = flip ? middleEdge.to : middleEdge.from;
    const h2 = flip ? middleEdge.from : middleEdge.to;
    if (!hiddenOk(h1, HARD_HIDDEN_MAX_RANK) || !hiddenOk(h2, HARD_HIDDEN_MAX_RANK)) continue;
    const middle = { type: middleEdge.type, h1Role: flip ? 'to' : 'from' };
    const aEdges = clueEdges(h1, HARD_KNOWN_MAX_RANK, [h2])
      .filter((e) => !(e.type === middleEdge.type && e.type === 'rhyme'))
      .slice(0, 8);
    if (aEdges.length === 0) continue;
    const bEdges = clueEdges(h2, HARD_KNOWN_MAX_RANK, [h1])
      .filter((e) => !(e.type === middleEdge.type && e.type === 'rhyme'))
      .slice(0, 8);
    let best = null;
    for (const eA of aEdges) {
      for (const eB of bEdges) {
        if (eA.other === eB.other || sharesStem(eA.other, eB.other)) continue;
        if (!isUniquePath4(h1, h2, eA, middle, eB)) continue;
        const score = scorePuzzle([eA.other, h1, h2, eB.other], [eA.type, middleEdge.type, eB.type], 'path4');
        if (!best || score > best.score) best = { eA, eB, score };
      }
    }
    if (!best) continue;
    const pairKey = [h1, h2].sort().join('|');
    if (seenHiddenPairs.has(pairKey)) continue;
    seenHiddenPairs.add(pairKey);

    const { eA, eB } = best;
    const midLink =
      middle.h1Role === 'from'
        ? { type: middle.type, from: 'w1', to: 'w2' }
        : { type: middle.type, from: 'w2', to: 'w1' };
    const path4 = {
      words: [word('w0', eA.other), word('w1', h1, true), word('w2', h2, true), word('w3', eB.other)],
      links: [link(eA.type, 'w1', 'w0', eA.role), midLink, link(eB.type, 'w2', 'w3', eB.role)],
    };
    pushCandidate(
      candidate(path4, [eA.other, h1, h2, eB.other], [eA.type, middle.type, eB.type], 'path4', best.score)
    );

    // Anchored variant: a third known clueing h2 from a fresh angle. Uniqueness only
    // tightens with an extra clue, so no re-check is needed.
    const usedTypes = new Set([middle.type, eB.type]);
    const anchor = clueEdges(h2, HARD_KNOWN_MAX_RANK, [h1, eA.other, eB.other]).find(
      (e) => !usedTypes.has(e.type)
    );
    if (anchor) {
      const anchored = {
        words: [...path4.words, word('w4', anchor.other)],
        links: [...path4.links, link(anchor.type, 'w2', 'w4', anchor.role)],
      };
      const anchoredWords = [eA.other, h1, h2, eB.other, anchor.other];
      const anchoredTypes = [eA.type, middle.type, eB.type, anchor.type];
      pushCandidate(
        candidate(anchored, anchoredWords, anchoredTypes, 'anchored', scorePuzzle(anchoredWords, anchoredTypes, 'anchored'))
      );
    }
  }
}
console.log(`  path4/anchored done (${easyCandidates.length} easy, ${hardCandidates.length} hard so far)`);

// --- HARD diamond: K1 and K2 each clue BOTH hiddens, via different relations ---

console.log('generating hard diamonds…');
let diamondCount = 0;
for (const [, group] of triplesByKnowns) {
  if (group.length < 2) continue;
  let taken = 0;
  for (let i = 0; i < group.length && taken < 2; i++) {
    for (let j = i + 1; j < group.length && taken < 2; j++) {
      const A = group[i];
      const B = group[j];
      if (A.hidden === B.hidden || sharesStem(A.hidden, B.hidden)) continue;
      // Line up each entry's edges by known word (e1/e2 order may differ per entry).
      const k1 = A.e1.other;
      const k2 = A.e2.other;
      const b1 = B.e1.other === k1 ? B.e1 : B.e2;
      const b2 = B.e1.other === k1 ? B.e2 : B.e1;
      // "connected in different ways": each known must clue the two hiddens differently.
      if (A.e1.type === b1.type && A.e2.type === b2.type) continue;
      const words = [k1, A.hidden, k2, B.hidden];
      const types = [A.e1.type, A.e2.type, b1.type, b2.type];
      const puzzle = {
        words: [word('w0', k1), word('w1', A.hidden, true), word('w2', k2), word('w3', B.hidden, true)],
        links: [
          link(A.e1.type, 'w1', 'w0', A.e1.role),
          link(A.e2.type, 'w1', 'w2', A.e2.role),
          link(b1.type, 'w3', 'w0', b1.role),
          link(b2.type, 'w3', 'w2', b2.role),
        ],
      };
      const c = candidate(puzzle, words, types, 'diamond', scorePuzzle(words, types, 'diamond'));
      if (c) {
        pushCandidate(c);
        diamondCount++;
        taken++;
      }
    }
  }
}
console.log(`  ${diamondCount} diamond candidates`);

// --- HARD path5 (three hiddens in a row) + loop5 (path5 closed into a ring) ---

console.log('generating hard path5 + loop5…');
/** Strict-edge relation between two known words, if any (used to close a loop5 ring). */
const strictLinkBetween = (a, b) => (graph.byWord.get(a) ?? []).find((e) => e.other === b);
let path5Count = 0;
let loop5Count = 0;
let path5Attempts = 0;
const PATH5_MAX_ATTEMPTS = 60_000;
outer: for (const [h2] of vocabRank) {
  if (!hiddenOk(h2, HARD_HIDDEN_MAX_RANK)) continue;
  const middlePool = (graph.byWord.get(h2) ?? [])
    .filter((e) => hiddenOk(e.other, HARD_HIDDEN_MAX_RANK) && !sharesStem(h2, e.other))
    .sort((a, b) => rank(a.other) - rank(b.other))
    .slice(0, 6);
  for (let i = 0; i < middlePool.length; i++) {
    for (let j = 0; j < middlePool.length; j++) {
      if (i === j) continue;
      const toH1 = middlePool[i]; // h2's edge to h1
      const toH3 = middlePool[j];
      const h1 = toH1.other;
      const h3 = toH3.other;
      if (h1 === h3 || sharesStem(h1, h3)) continue;
      // e12 seen from h1's side; e23 seen from h3's side (for candidate expansion).
      const e12 = { type: toH1.type, h1Role: otherRole(toH1.role) };
      const e23 = { type: toH3.type, h3Role: otherRole(toH3.role) };
      const aEdge = clueEdges(h1, HARD_KNOWN_MAX_RANK, [h2, h3])[0];
      const bEdge = clueEdges(h3, HARD_KNOWN_MAX_RANK, [h1, h2, aEdge?.other ?? ''])[0];
      if (!aEdge || !bEdge) continue;
      if (++path5Attempts > PATH5_MAX_ATTEMPTS) break outer;
      if (!isUniquePath5(h1, h2, h3, aEdge, e12, e23, bEdge)) continue;
      const words = [aEdge.other, h1, h2, h3, bEdge.other];
      const types = [aEdge.type, toH1.type, toH3.type, bEdge.type];
      const puzzle = {
        words: [
          word('w0', aEdge.other),
          word('w1', h1, true),
          word('w2', h2, true),
          word('w3', h3, true),
          word('w4', bEdge.other),
        ],
        links: [
          link(aEdge.type, 'w1', 'w0', aEdge.role),
          e12.h1Role === 'from'
            ? { type: e12.type, from: 'w1', to: 'w2' }
            : { type: e12.type, from: 'w2', to: 'w1' },
          e23.h3Role === 'from'
            ? { type: e23.type, from: 'w3', to: 'w2' }
            : { type: e23.type, from: 'w2', to: 'w3' },
          link(bEdge.type, 'w3', 'w4', bEdge.role),
        ],
      };
      const c = candidate(puzzle, words, types, 'path5', scorePuzzle(words, types, 'path5'));
      if (c) {
        pushCandidate(c);
        path5Count++;
      }

      // loop5: the SAME three-hidden chain, but close the ring with a relation between the
      // two end knowns (w0 — w4). Only two words are shown, and uniqueness is exactly the
      // path5 uniqueness just verified — the closing link joins two KNOWN words, so it adds
      // no constraint on the hiddens, it only makes the shape a full loop.
      const closer = strictLinkBetween(aEdge.other, bEdge.other);
      if (closer) {
        const loopTypes = [...types, closer.type];
        const loop = {
          words: puzzle.words,
          links: [...puzzle.links, link(closer.type, 'w0', 'w4', closer.role)],
        };
        const cl = candidate(loop, words, loopTypes, 'loop5', scorePuzzle(words, loopTypes, 'loop5'));
        if (cl) {
          pushCandidate(cl);
          loop5Count++;
        }
      }
    }
  }
}
console.log(`  ${path5Count} path5 + ${loop5Count} loop5 candidates (${path5Attempts} joint checks)`);

// ---------- selection: balance link types, dedupe stems, cap shapes ----------

/**
 * Greedy pick, best score first — but each round targets the LINK TYPE currently
 * rarest in the bank, so all 8 relation types end up in roughly equal numbers
 * (rare-edge types like sequence/antonym/meronym would otherwise be drowned out
 * by the tens of thousands of rhyme/hypernym candidates). Guards:
 *  - each word STEM (first 4 letters) appears in at most one puzzle, so LEFT/felt
 *    and FELT/left — or COURSE and COURSES — can't both make the bank;
 *  - optional per-shape quota keeps the hard bank's structure mix.
 *
 * `stockpile` (manually accepted puzzles for this difficulty) is force-included ahead of
 * the loop, exempt from every guard below. The stem/type/shape guards are measured over
 * the FRESH pool alone: fresh puzzles don't collide with EACH OTHER (so you never review
 * two near-identical new ones), but a fresh puzzle MAY reuse a word that appears in some
 * accepted puzzle — with a large stockpile, forbidding that starves the rarer shapes
 * (diamonds especially) and would shrink the review pool. It's not a duplicate: exact
 * repeats of accepted/skipped puzzles are already excluded by id in candidate().
 * Exactly `freshTarget` fresh puzzles are picked (or as many as exist), on top of the
 * whole stockpile — the bank size therefore grows with accepted.json, never shrinks the
 * review pool to zero the way a fixed total cap did.
 *
 * The stockpile keeps the exact order it has in accepted.json (append-only — see
 * review.html's copy button) and is placed FIRST, unshuffled. Only the freshly-picked
 * filler is shuffled, and only among itself. This means every puzzle you've already
 * accepted and shipped stays pinned to the same bank index — and so the same day —
 * forever, no matter how many more puzzles you accept later or how the fresh pool
 * changes; only the not-yet-curated filler tail reshuffles across regenerations.
 */
function pickBalanced(candidates, freshTarget, shapeQuota = null, stockpile = []) {
  // Guards are measured over the fresh pool only (nothing seeded from the stockpile), so
  // fresh puzzles balance among themselves. STEM_EXEMPT_SHAPES skip the stem guard entirely.
  const usedStems = new Set();
  const typeCount = new Map(LINK_TYPE_LIST.map((t) => [t, 0]));
  const shapeCount = new Map();
  const fresh = [];

  const withinQuota = (c) => !shapeQuota || (shapeCount.get(c.shape) ?? 0) < (shapeQuota[c.shape] ?? Infinity);
  const canTake = (c) =>
    (STEM_EXEMPT_SHAPES.has(c.shape) || !c.stems.some((s) => usedStems.has(s))) && withinQuota(c);
  const take = (c) => {
    fresh.push(c);
    // Exempt shapes don't reserve their stems, so they never block other picks.
    if (!STEM_EXEMPT_SHAPES.has(c.shape)) for (const s of c.stems) usedStems.add(s);
    for (const t of c.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    shapeCount.set(c.shape, (shapeCount.get(c.shape) ?? 0) + 1);
  };

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  // Force-include the rare/new shapes first (best score first, respecting their own guards):
  // they're so scarce the type-balanced loop below would let the abundant shapes (path3 /
  // path4 / path5) fill the freshTarget before enough of them land.
  const remaining = [];
  for (const c of sorted) {
    if (FORCE_FIRST_SHAPES.has(c.shape) && fresh.length < freshTarget && canTake(c)) take(c);
    else remaining.push(c);
  }

  while (fresh.length < freshTarget && remaining.length > 0) {
    const typesByNeed = [...typeCount.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
    let idx = -1;
    for (const t of typesByNeed) {
      idx = remaining.findIndex((c) => c.types.includes(t) && canTake(c));
      if (idx !== -1) break;
    }
    if (idx === -1) idx = remaining.findIndex(canTake);
    if (idx === -1) break;
    take(remaining.splice(idx, 1)[0]);
  }
  const rnd = mulberry32(SEED);
  return { picked: [...stockpile, ...shuffle(fresh, rnd)], typeCount, shapeCount };
}

// Difficulty of an accepted puzzle follows its SHAPE, not the (possibly stale) diff stored
// in accepted.json — so reclassifying a shape (anchored → easy) automatically moves every
// already-accepted puzzle of that shape into the right track.
const acceptedEasy = accepted.filter((a) => diffOfShape(deriveShape(a.puzzle)) === 'easy').map(acceptedCandidate);
const acceptedHard = accepted.filter((a) => diffOfShape(deriveShape(a.puzzle)) === 'hard').map(acceptedCandidate);
{
  const byShape = (arr) => arr.reduce((m, c) => ((m[c.shape] = (m[c.shape] ?? 0) + 1), m), {});
  console.log('  easy candidate pool:', byShape(easyCandidates));
  console.log('  hard candidate pool:', byShape(hardCandidates));
}
const easy = pickBalanced(easyCandidates, FRESH_TARGET, EASY_SHAPE_QUOTA, acceptedEasy);
const hard = pickBalanced(hardCandidates, FRESH_TARGET, HARD_SHAPE_QUOTA, acceptedHard);
if (acceptedEasy.length > 0 || acceptedHard.length > 0) {
  console.log(`stockpile: ${acceptedEasy.length} easy + ${acceptedHard.length} hard puzzles locked in`);
}
console.log('easy link types:', Object.fromEntries(easy.typeCount));
console.log('easy shapes:', Object.fromEntries(easy.shapeCount));
console.log('hard link types:', Object.fromEntries(hard.typeCount));
console.log('hard shapes:', Object.fromEntries(hard.shapeCount));

// ---------- emit bank ----------

const banner = `/** AUTO-GENERATED by scripts/puzzlegen/generate.mjs — do not edit by hand.
 *  ${easy.picked.length} easy + ${hard.picked.length} hard machine-generated daily puzzles.
 *  Every puzzle passed a uniqueness check: no other word (or word tuple) in a
 *  ~${Math.round(vLex.size / 1000)}k-word lexicon fits all the clues at the answers' lengths.
 *  Vet puzzles in scripts/puzzlegen/review.html; skips + banned links live in rejects.json. */
import type { Puzzle } from './puzzle';

export const easyPuzzles: Puzzle[] = ${JSON.stringify(easy.picked.map((c) => c.puzzle), null, 2)};

export const hardPuzzles: Puzzle[] = ${JSON.stringify(hard.picked.map((c) => c.puzzle), null, 2)};
`;
writeFileSync(join(ROOT, 'src', 'shared', 'puzzleBank.ts'), banner);

// ---------- emit report + review page ----------

/** "GIRL —becomes→ [WOMAN]" per link, hidden words bracketed. */
function chainLines(puzzle) {
  const text = new Map(puzzle.words.map((w) => [w.id, w.hidden ? `[${w.text}]` : w.text]));
  return puzzle.links.map((l) => `${text.get(l.from)} —${LABELS[l.type]}→ ${text.get(l.to)}`);
}

const reportLines = [];
for (const [name, sel] of [['EASY', easy], ['HARD', hard]]) {
  reportLines.push(name, '====');
  sel.picked.forEach((c, i) => {
    reportLines.push(
      `#${String(i + 1).padStart(3)} ${c.id.padStart(8)} [${c.score.toFixed(1)}] (${c.shape})  ${chainLines(c.puzzle).join('   |   ')}`
    );
  });
  reportLines.push('');
}
writeFileSync(join(HERE, 'report.txt'), reportLines.join('\n'));

const reviewData = [];
for (const [diff, sel] of [['easy', easy], ['hard', hard]]) {
  for (const c of sel.picked) {
    reviewData.push({
      id: c.id,
      diff,
      shape: c.shape,
      score: Number(c.score.toFixed(1)),
      lines: chainLines(c.puzzle),
      puzzle: c.puzzle,
    });
  }
}
const reviewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WordFish puzzle review</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
  header { position: sticky; top: 0; background: Canvas; padding: .6rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); z-index: 2; display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; }
  button { font: inherit; padding: .3rem .8rem; border-radius: .5rem; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: transparent; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.primary.accept { background: #16a34a; border-color: #16a34a; }
  label.filter { font-size: .85rem; display: flex; align-items: center; gap: .35rem; }
  label.gameurl { font-size: .8rem; display: flex; align-items: center; gap: .35rem; margin-left: auto; opacity: .8; }
  label.gameurl input { font: inherit; width: 11rem; padding: .2rem .4rem; border-radius: .4rem; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: transparent; color: inherit; }
  .preview-btn { background: color-mix(in srgb, #7c3aed 12%, transparent); border-color: #7c3aed; }
  .card { display: flex; gap: .9rem; align-items: center; padding: .55rem .7rem; border-radius: .6rem; margin: .4rem 0; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  .card.skipped { opacity: .5; background: color-mix(in srgb, CanvasText 6%, transparent); }
  .card.accepted { background: color-mix(in srgb, #16a34a 10%, transparent); border-color: color-mix(in srgb, #16a34a 40%, transparent); }
  .meta { font-size: .75rem; opacity: .65; min-width: 8.5rem; }
  .chain { flex: 1; }
  .linkrow { display: flex; align-items: center; gap: .5rem; }
  .chainline { font-size: .95rem; }
  .linkrow .ban-link { font-size: .7rem; padding: .05rem .4rem; min-width: 0; opacity: 0; border-radius: .4rem; }
  .card:hover .ban-link, .ban-link.on { opacity: 1; }
  .ban-link.on { background: #b45309; border-color: #b45309; color: #fff; }
  .linkrow.link-banned .chainline { text-decoration: line-through; opacity: .5; }
  .chain b { color: #2563eb; }
  .btns { margin-left: auto; display: flex; gap: .4rem; flex-shrink: 0; }
  .btns button { min-width: 4.6rem; }
  .accept-btn.on { background: #16a34a; border-color: #16a34a; color: #fff; }
  .skip-btn.on { background: color-mix(in srgb, CanvasText 55%, transparent); border-color: color-mix(in srgb, CanvasText 55%, transparent); color: Canvas; }
  h2 { margin-top: 1.6rem; }
  #status { font-size: .85rem; opacity: .75; }
  .hint { font-size: .85rem; opacity: .75; margin: 1rem 0; }
</style>
</head>
<body>
<header>
  <strong>WordFish puzzle review</strong>
  <span id="status"></span>
  <button class="primary accept" id="copyAccepted">Copy accepted.json</button>
  <button class="primary" id="copyRejected">Copy rejects.json</button>
  <label class="filter"><input type="checkbox" id="hideAccepted"> hide already-accepted</label>
  <label class="gameurl">game server:
    <input type="text" id="gameUrl" placeholder="http://localhost:5173/src/client" spellcheck="false">
  </label>
</header>
<p class="hint"><em>Accept</em> locks a puzzle into the permanent stockpile — every future
regeneration includes it verbatim, so it's off your plate for good. <em>Ban</em> (per clue,
appears on hover) is the main tool: it vetoes that single link everywhere, so every future
puzzle built on that bad relation is dropped while variants that fix it stay eligible.
<em>Skip</em> passes on just this one puzzle — too easy or boring, nothing actually wrong — so
that exact puzzle won't reappear but its words and clues stay free to use elsewhere. After
marking some, copy whichever file(s) changed, paste over the matching file in
<code>scripts/puzzlegen/</code>, and re-run <code>npm run generate:puzzles</code> — accepted
puzzles keep their slot, skipped/banned ones are replaced by fresh candidates. Toggling a button
back off before copying retracts that decision. ${accepted.length} puzzle(s) in the stockpile,
${skips.size} skipped id(s) and ${bannedLinks.size} banned link(s) are pre-marked below. <em>Preview</em> opens
the puzzle in the actual running game — start a dev server first, then adjust the "game server"
field above to wherever <code>game.html</code> actually loads for you (e.g. just the origin if
your server root IS <code>src/client</code>, or add the <code>/src/client</code> path if it's
serving from the repo root instead); saved for next time.</p>
<div id="list"></div>
<script>
const DATA = ${JSON.stringify(reviewData).replace(/</g, '\\u003c')};
const PRIOR_ACCEPTED = ${JSON.stringify(accepted).replace(/</g, '\\u003c')};
const PRIOR_REJECTS = ${JSON.stringify(rejectsData).replace(/</g, '\\u003c')};

const linkKey = (type, a, b) => type + '|' + [a, b].sort().join('~');

const acceptedMap = new Map(PRIOR_ACCEPTED.map((a) => [a.id, a]));
// ids the vetter skipped (passed over — that exact puzzle just won't be re-emitted).
const skippedSet = new Set(PRIOR_REJECTS.skips ?? PRIOR_REJECTS.ids ?? []);
// linkKey -> {type, words:[a,b]} for every banned clue.
const bannedLinks = new Map();
for (const l of PRIOR_REJECTS.links ?? []) bannedLinks.set(linkKey(l.type, l.words[0], l.words[1]), { type: l.type, words: [...l.words].sort() });
const list = document.getElementById('list');
const status = document.getElementById('status');
const hideAccepted = document.getElementById('hideAccepted');

// Remembered across visits so you only ever type your dev server's port once.
const GAME_URL_KEY = 'wordfish-review-game-url';
const gameUrlInput = document.getElementById('gameUrl');
gameUrlInput.value = localStorage.getItem(GAME_URL_KEY) ?? 'http://localhost:5173/src/client';
gameUrlInput.addEventListener('change', () => {
  localStorage.setItem(GAME_URL_KEY, gameUrlInput.value.trim());
});

let currentDiff = '';
for (const p of DATA) {
  if (p.diff !== currentDiff) {
    currentDiff = p.diff;
    const h = document.createElement('h2');
    h.textContent = currentDiff.toUpperCase();
    list.appendChild(h);
  }
  const card = document.createElement('div');
  card.className = 'card';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = p.diff + ' · ' + p.shape + ' · ' + p.score + ' · ' + p.id;
  const chain = document.createElement('div');
  chain.className = 'chain';
  // p.lines is index-aligned with p.puzzle.links (both come from the same map), so line i
  // describes link i — that lets each rendered clue carry its own ban toggle.
  const slotText = new Map(p.puzzle.words.map((w) => [w.id, w.text]));
  p.lines.forEach((line, i) => {
    const lk = p.puzzle.links[i];
    const key = linkKey(lk.type, slotText.get(lk.from), slotText.get(lk.to));
    const row = document.createElement('div');
    row.className = 'linkrow';
    const d = document.createElement('span');
    d.className = 'chainline';
    d.innerHTML = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/\\[([A-Z]+)\\]/g, '<b>[$1]</b>');
    const banBtn = document.createElement('button');
    banBtn.className = 'ban-link';
    banBtn.title = 'Veto every future puzzle that uses this exact clue';
    const refreshBan = () => {
      const on = bannedLinks.has(key);
      banBtn.classList.toggle('on', on);
      banBtn.textContent = on ? 'banned' : 'ban';
      row.classList.toggle('link-banned', on);
    };
    banBtn.onclick = () => {
      if (bannedLinks.has(key)) bannedLinks.delete(key);
      else bannedLinks.set(key, { type: lk.type, words: [slotText.get(lk.from), slotText.get(lk.to)].sort() });
      refreshBan();
      update();
    };
    refreshBan();
    row.append(d, banBtn);
    chain.appendChild(row);
  });
  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'accept-btn';
  const skipBtn = document.createElement('button');
  skipBtn.className = 'skip-btn';
  skipBtn.title = 'Pass on this exact puzzle (too easy/boring) — it just won\\'t reappear';
  const refresh = () => {
    const isAccepted = acceptedMap.has(p.id);
    const isSkipped = skippedSet.has(p.id);
    card.classList.toggle('accepted', isAccepted);
    card.classList.toggle('skipped', isSkipped);
    acceptBtn.classList.toggle('on', isAccepted);
    skipBtn.classList.toggle('on', isSkipped);
    acceptBtn.textContent = isAccepted ? 'accepted' : 'accept';
    skipBtn.textContent = isSkipped ? 'skipped' : 'skip';
    card.style.display = hideAccepted.checked && isAccepted ? 'none' : '';
  };
  acceptBtn.onclick = () => {
    if (acceptedMap.has(p.id)) acceptedMap.delete(p.id);
    else {
      acceptedMap.set(p.id, { id: p.id, diff: p.diff, score: p.score, puzzle: p.puzzle });
      skippedSet.delete(p.id); // accepting overrides a prior skip
    }
    refresh();
    update();
  };
  skipBtn.onclick = () => {
    if (skippedSet.has(p.id)) skippedSet.delete(p.id);
    else {
      skippedSet.add(p.id);
      acceptedMap.delete(p.id); // skipping evicts it from the stockpile
    }
    refresh();
    update();
  };
  const previewBtn = document.createElement('button');
  previewBtn.className = 'preview-btn';
  previewBtn.textContent = 'preview';
  previewBtn.title = 'Open this puzzle in the running game';
  previewBtn.onclick = () => {
    const base = (gameUrlInput.value || 'http://localhost:5173/src/client').trim().replace(/\\/+$/, '');
    const url = base + '/game.html?previewPuzzle=' + encodeURIComponent(JSON.stringify(p.puzzle));
    window.open(url, '_blank');
  };
  const btns = document.createElement('div');
  btns.className = 'btns';
  btns.append(previewBtn, acceptBtn, skipBtn);
  card.append(meta, chain, btns);
  list.appendChild(card);
  refresh();
}
function update() {
  status.textContent =
    acceptedMap.size + ' accepted (of ' + PRIOR_ACCEPTED.length + ' prior) · ' +
    skippedSet.size + ' skipped · ' +
    bannedLinks.size + ' banned link(s)';
}
hideAccepted.onchange = () => {
  for (const card of list.querySelectorAll('.card')) {
    card.style.display = hideAccepted.checked && card.classList.contains('accepted') ? 'none' : '';
  }
};
document.getElementById('copyAccepted').onclick = async () => {
  // Insertion order, NOT sorted: generate.mjs pins each accepted puzzle to the bank
  // index matching its position here, so newly-accepted puzzles must land at the end
  // (a Map only reorders a key when it's deleted and re-added, which is what happens
  // when a puzzle is un-accepted/re-accepted — see the accept/reject handlers above).
  const all = [...acceptedMap.values()];
  await navigator.clipboard.writeText(JSON.stringify(all, null, 2) + '\\n');
  const b = document.getElementById('copyAccepted');
  const old = b.textContent;
  b.textContent = 'Copied ' + all.length + ' ✓';
  setTimeout(() => (b.textContent = old), 1500);
};
document.getElementById('copyRejected').onclick = async () => {
  const out = {
    skips: [...skippedSet].sort(),
    links: [...bannedLinks.values()],
  };
  await navigator.clipboard.writeText(JSON.stringify(out, null, 2) + '\\n');
  const b = document.getElementById('copyRejected');
  const old = b.textContent;
  b.textContent = 'Copied ' + out.skips.length + 's/' + out.links.length + 'b ✓';
  setTimeout(() => (b.textContent = old), 1500);
};
update();
</script>
</body>
</html>
`;
writeFileSync(join(HERE, 'review.html'), reviewHtml);

console.log(`wrote ${easy.picked.length} easy + ${hard.picked.length} hard puzzles to src/shared/puzzleBank.ts`);
console.log('curation: open scripts/puzzlegen/review.html (report.txt for plain text)');
