/**
 * Daily-puzzle generator. Run with:  npm run generate:puzzles
 *
 * Pipeline:
 *  1. Vocab = top-10k English words by frequency (+ curated sequence words).
 *  2. Relation graph over the vocab (WordNet, CMU rhymes, computed letterplay,
 *     curated sequences) — see graph.mjs for the strict/liberal split.
 *  3. Assemble puzzles in several shapes:
 *       EASY   path3    known — [hidden] — known
 *       HARD   path4    known — [hidden] — [hidden] — known
 *              diamond  two knowns, each linked to BOTH hiddens (a 4-cycle)
 *              anchored path4 plus a third known clueing one of the hiddens
 *              path5    known — [hidden] — [hidden] — [hidden] — known
 *  4. Every candidate passes a uniqueness check: no other word (or word tuple) in a
 *     ~73k-word lexicon satisfies all the clues at the answers' lengths.
 *  5. Manual vetting via review.html: ACCEPT locks a puzzle into a permanent stockpile
 *     (accepted.json) that every future run includes verbatim, no matter how the
 *     generator or scoring changes later; REJECT vetoes a puzzle's id forever
 *     (rejects.json). A regeneration fills only the slots not already covered by the
 *     accepted stockpile.
 *  6. Selection balances LINK TYPES (rarer relation types are prioritized so all 8
 *     appear in roughly equal numbers), dedupes by word stem, caps each hard shape, then
 *     places the accepted stockpile first (fixed, append-only order — never reshuffled,
 *     so a shipped puzzle's day never changes) followed by freshly-picked filler
 *     (shuffled deterministically, among itself only), then emits:
 *       - src/client/puzzle/puzzleBank.ts  (typed, committed, shipped to the client)
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
const BANK_SIZE = 120; // per difficulty
// How many of each hard shape the bank may hold, at most (they compete on score/type
// balance below the caps; shortfalls in one shape are filled by the others).
const HARD_SHAPE_QUOTA = { path4: 45, diamond: 40, anchored: 25, path5: 15 };

// Rank ceilings (google-10k index): how common words must be for each slot.
const EASY_HIDDEN_MAX_RANK = 3500;
const EASY_KNOWN_MAX_RANK = 4500;
const HARD_HIDDEN_MAX_RANK = 6500;
const HARD_KNOWN_MAX_RANK = 5500;
const SEQ_WORD_RANK = 4000; // rank assigned to curated sequence words missing from the list

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

// Validation lexicon: vocab + every single-word WordNet lemma. ~70k words a solver
// might legitimately answer with — the uniqueness check runs against this.
const vLex = new Set(vocabRank.keys());
for (const [lemmaFile] of wn.senses) {
  const lemma = lemmaFile.slice(0, lemmaFile.indexOf('|'));
  if (/^[a-z]+$/.test(lemma) && lemma.length >= 3 && lemma.length <= 12) vLex.add(lemma);
}

const cmu = parseCmu(readFileSync(join(HERE, 'data', 'cmudict.dict'), 'utf8'));

console.log(`vocab ${vocabRank.size}, lexicon ${vLex.size} — building graph…`);
const graph = buildGraph({ wn, vocabRank, vLex, cmu, sequencePairs: SEQUENCE_PAIRS });
{
  const counts = new Map();
  for (const e of graph.strictEdges) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  console.log('strict edges:', Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])));
}

// Previously vetoed puzzles (see review.html) — never re-emit these.
const rejectsPath = join(HERE, 'rejects.json');
const rejects = new Set(existsSync(rejectsPath) ? JSON.parse(readFileSync(rejectsPath, 'utf8')) : []);
if (rejects.size > 0) console.log(`loaded ${rejects.size} rejected puzzle ids`);

// Manually approved puzzles (see review.html) — the permanent stockpile. Stored as full
// puzzle objects (not just ids) so they survive changes to the generator/scoring/graph;
// every run includes ALL of them verbatim, on top of whatever fresh slots remain. A
// reject can retroactively evict a previously accepted puzzle (filtered out below).
const acceptedPath = join(HERE, 'accepted.json');
const acceptedRaw = existsSync(acceptedPath) ? JSON.parse(readFileSync(acceptedPath, 'utf8')) : [];
const accepted = acceptedRaw.filter((a) => !rejects.has(a.id));
if (accepted.length > 0) console.log(`loaded ${accepted.length} accepted puzzles from the stockpile`);

// A puzzle's shape is fully determined by (word count, hidden count, link count) — see
// the shape comment at the top of this file for what each combination looks like.
const SHAPE_BY_SIGNATURE = {
  '3|1|2': 'path3',
  '4|2|3': 'path4',
  '4|2|4': 'diamond',
  '5|2|4': 'anchored',
  '5|3|4': 'path5',
};
function deriveShape(puzzle) {
  const hiddenCount = puzzle.words.filter((w) => w.hidden).length;
  return SHAPE_BY_SIGNATURE[`${puzzle.words.length}|${hiddenCount}|${puzzle.links.length}`] ?? 'custom';
}
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
  if (shape === 'diamond' || shape === 'path5') score += 1; // novelty
  if (shape === 'anchored') score += 0.5;
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
  if (rejects.has(id) || acceptedIds.has(id)) return null;
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

// --- EASY (path3) + the unique (hidden, known, known) triples diamonds are built from ---

console.log('generating easy + collecting unique triples…');
const easyCandidates = [];
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
    const c = candidate(puzzle, [e1.other, hidden, e2.other], [e1.type, e2.type], 'path3', score);
    if (c) easyCandidates.push(c);
  }
}
console.log(`  ${easyCandidates.length} easy candidates, ${triplesByKnowns.size} known-pairs`);

// --- HARD path4 (+ anchored variant) ---

console.log('generating hard path4 + anchored…');
const hardCandidates = [];
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
    const c4 = candidate(
      path4,
      [eA.other, h1, h2, eB.other],
      [eA.type, middle.type, eB.type],
      'path4',
      best.score
    );
    if (c4) hardCandidates.push(c4);

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
      const cA = candidate(
        anchored,
        [eA.other, h1, h2, eB.other, anchor.other],
        [eA.type, middle.type, eB.type, anchor.type],
        'anchored',
        scorePuzzle(
          [eA.other, h1, h2, eB.other, anchor.other],
          [eA.type, middle.type, eB.type, anchor.type],
          'anchored'
        )
      );
      if (cA) hardCandidates.push(cA);
    }
  }
}
console.log(`  ${hardCandidates.length} path4/anchored candidates`);

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
        hardCandidates.push(c);
        diamondCount++;
        taken++;
      }
    }
  }
}
console.log(`  ${diamondCount} diamond candidates`);

// --- HARD path5: three hiddens in a row ---

console.log('generating hard path5…');
let path5Count = 0;
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
        hardCandidates.push(c);
        path5Count++;
      }
    }
  }
}
console.log(`  ${path5Count} path5 candidates (${path5Attempts} joint checks)`);

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
 * `stockpile` (manually accepted puzzles for this difficulty) is force-included ahead
 * of the loop, exempt from every guard above — the vetter already judged each one
 * individually, so two accepted puzzles ARE allowed to share a stem. Fresh candidates
 * still avoid colliding with the stockpile's stems/types/shapes. If the stockpile alone
 * meets or exceeds `size`, no fresh candidates are picked at all — nothing accepted is
 * ever dropped to make room, the bank simply grows past `size`.
 *
 * The stockpile keeps the exact order it has in accepted.json (append-only — see
 * review.html's copy button) and is placed FIRST, unshuffled. Only the freshly-picked
 * filler is shuffled, and only among itself. This means every puzzle you've already
 * accepted and shipped stays pinned to the same bank index — and so the same day —
 * forever, no matter how many more puzzles you accept later or how the fresh pool
 * changes; only the not-yet-curated filler tail reshuffles across regenerations.
 */
function pickBalanced(candidates, size, shapeQuota = null, stockpile = []) {
  const usedStems = new Set();
  const typeCount = new Map(LINK_TYPE_LIST.map((t) => [t, 0]));
  const shapeCount = new Map();
  for (const s of stockpile) {
    for (const st of s.stems) usedStems.add(st);
    for (const t of s.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    shapeCount.set(s.shape, (shapeCount.get(s.shape) ?? 0) + 1);
  }

  const remaining = [...candidates].sort((a, b) => b.score - a.score);
  const canTake = (c) =>
    !c.stems.some((s) => usedStems.has(s)) &&
    (!shapeQuota || (shapeCount.get(c.shape) ?? 0) < (shapeQuota[c.shape] ?? Infinity));

  const fresh = [];
  while (stockpile.length + fresh.length < size && remaining.length > 0) {
    const typesByNeed = [...typeCount.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
    let idx = -1;
    for (const t of typesByNeed) {
      idx = remaining.findIndex((c) => c.types.includes(t) && canTake(c));
      if (idx !== -1) break;
    }
    if (idx === -1) idx = remaining.findIndex(canTake);
    if (idx === -1) break;
    const chosen = remaining.splice(idx, 1)[0];
    fresh.push(chosen);
    for (const s of chosen.stems) usedStems.add(s);
    for (const t of chosen.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    shapeCount.set(chosen.shape, (shapeCount.get(chosen.shape) ?? 0) + 1);
  }
  const rnd = mulberry32(SEED);
  return { picked: [...stockpile, ...shuffle(fresh, rnd)], typeCount, shapeCount };
}

const acceptedEasy = accepted.filter((a) => a.diff === 'easy').map(acceptedCandidate);
const acceptedHard = accepted.filter((a) => a.diff === 'hard').map(acceptedCandidate);
const easy = pickBalanced(easyCandidates, BANK_SIZE, null, acceptedEasy);
const hard = pickBalanced(hardCandidates, BANK_SIZE, HARD_SHAPE_QUOTA, acceptedHard);
if (acceptedEasy.length > 0 || acceptedHard.length > 0) {
  console.log(`stockpile: ${acceptedEasy.length} easy + ${acceptedHard.length} hard puzzles locked in`);
}
console.log('easy link types:', Object.fromEntries(easy.typeCount));
console.log('hard link types:', Object.fromEntries(hard.typeCount));
console.log('hard shapes:', Object.fromEntries(hard.shapeCount));

// ---------- emit bank ----------

const banner = `/** AUTO-GENERATED by scripts/puzzlegen/generate.mjs — do not edit by hand.
 *  ${easy.picked.length} easy + ${hard.picked.length} hard machine-generated daily puzzles.
 *  Every puzzle passed a uniqueness check: no other word (or word tuple) in a
 *  ~${Math.round(vLex.size / 1000)}k-word lexicon fits all the clues at the answers' lengths.
 *  Vet puzzles in scripts/puzzlegen/review.html; rejected ids live in rejects.json. */
import type { Puzzle } from './types';

export const easyPuzzles: Puzzle[] = ${JSON.stringify(easy.picked.map((c) => c.puzzle), null, 2)};

export const hardPuzzles: Puzzle[] = ${JSON.stringify(hard.picked.map((c) => c.puzzle), null, 2)};
`;
writeFileSync(join(ROOT, 'src', 'client', 'puzzle', 'puzzleBank.ts'), banner);

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
  .card.rejected { opacity: .45; background: color-mix(in srgb, #dc2626 8%, transparent); }
  .card.rejected .chain { text-decoration: line-through; }
  .card.accepted { background: color-mix(in srgb, #16a34a 10%, transparent); border-color: color-mix(in srgb, #16a34a 40%, transparent); }
  .meta { font-size: .75rem; opacity: .65; min-width: 8.5rem; }
  .chain div { font-size: .95rem; }
  .chain b { color: #2563eb; }
  .btns { margin-left: auto; display: flex; gap: .4rem; flex-shrink: 0; }
  .btns button { min-width: 4.6rem; }
  .accept-btn.on { background: #16a34a; border-color: #16a34a; color: #fff; }
  .reject-btn.on { background: #dc2626; border-color: #dc2626; color: #fff; }
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
regeneration includes it verbatim, so it's off your plate for good. <em>Reject</em> vetoes a
puzzle's id forever. After marking some, copy whichever file(s) changed, paste over the
matching file in <code>scripts/puzzlegen/</code>, and re-run <code>npm run generate:puzzles</code>
— accepted puzzles keep their slot, rejected ones are replaced by fresh candidates. Toggling
a button back off before copying retracts that decision. ${accepted.length} puzzle(s) already
in the stockpile and ${rejects.size} rejected id(s) are pre-marked below. <em>Preview</em> opens
the puzzle in the actual running game — start a dev server first, then adjust the "game server"
field above to wherever <code>game.html</code> actually loads for you (e.g. just the origin if
your server root IS <code>src/client</code>, or add the <code>/src/client</code> path if it's
serving from the repo root instead); saved for next time.</p>
<div id="list"></div>
<script>
const DATA = ${JSON.stringify(reviewData).replace(/</g, '\\u003c')};
const PRIOR_ACCEPTED = ${JSON.stringify(accepted).replace(/</g, '\\u003c')};
const PRIOR_REJECTS = ${JSON.stringify([...rejects]).replace(/</g, '\\u003c')};

const acceptedMap = new Map(PRIOR_ACCEPTED.map((a) => [a.id, a]));
const rejectedSet = new Set(PRIOR_REJECTS);
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
  for (const line of p.lines) {
    const d = document.createElement('div');
    d.innerHTML = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/\\[([A-Z]+)\\]/g, '<b>[$1]</b>');
    chain.appendChild(d);
  }
  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'accept-btn';
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'reject-btn';
  const refresh = () => {
    const isAccepted = acceptedMap.has(p.id);
    const isRejected = rejectedSet.has(p.id);
    card.classList.toggle('accepted', isAccepted);
    card.classList.toggle('rejected', isRejected);
    acceptBtn.classList.toggle('on', isAccepted);
    rejectBtn.classList.toggle('on', isRejected);
    acceptBtn.textContent = isAccepted ? 'accepted' : 'accept';
    rejectBtn.textContent = isRejected ? 'rejected' : 'reject';
    card.style.display = hideAccepted.checked && isAccepted ? 'none' : '';
  };
  acceptBtn.onclick = () => {
    if (acceptedMap.has(p.id)) acceptedMap.delete(p.id);
    else {
      acceptedMap.set(p.id, { id: p.id, diff: p.diff, score: p.score, puzzle: p.puzzle });
      rejectedSet.delete(p.id); // accepting overrides a prior reject
    }
    refresh();
    update();
  };
  rejectBtn.onclick = () => {
    if (rejectedSet.has(p.id)) rejectedSet.delete(p.id);
    else {
      rejectedSet.add(p.id);
      acceptedMap.delete(p.id); // rejecting evicts it from the stockpile
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
  btns.append(previewBtn, acceptBtn, rejectBtn);
  card.append(meta, chain, btns);
  list.appendChild(card);
  refresh();
}
function update() {
  status.textContent =
    acceptedMap.size + ' accepted (of ' + PRIOR_ACCEPTED.length + ' prior) · ' +
    rejectedSet.size + ' rejected (of ' + PRIOR_REJECTS.length + ' prior)';
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
  const all = [...rejectedSet].sort();
  await navigator.clipboard.writeText(JSON.stringify(all, null, 2) + '\\n');
  const b = document.getElementById('copyRejected');
  const old = b.textContent;
  b.textContent = 'Copied ' + all.length + ' ✓';
  setTimeout(() => (b.textContent = old), 1500);
};
update();
</script>
</body>
</html>
`;
writeFileSync(join(HERE, 'review.html'), reviewHtml);

console.log(`wrote ${easy.picked.length} easy + ${hard.picked.length} hard puzzles to src/client/puzzle/puzzleBank.ts`);
console.log('curation: open scripts/puzzlegen/review.html (report.txt for plain text)');
