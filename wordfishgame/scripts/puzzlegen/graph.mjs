/**
 * Builds the word-relation graph puzzles are generated from.
 *
 * Two views of every relation:
 *  - STRICT edges — used to BUILD puzzles. High-precision: only common vocab words,
 *    only each lemma's most frequent WordNet senses, stem-clash filters. A strict edge
 *    should read as obviously true to a casual solver.
 *  - LIBERAL predicates/candidate sets — used to CHECK UNIQUENESS. High-recall: all
 *    senses, a much larger lexicon, no aesthetic filters. If ANY word a solver might
 *    reasonably think of satisfies all of a hidden slot's clues, the puzzle is rejected.
 *
 * Edge direction follows the puzzle model (src/shared/puzzle.ts):
 *  hypernym: from = broader word     meronym:      from = part, to = whole
 *  sequence: from becomes to         lettersubset: from's letters hide inside to
 *  synonym / antonym / anagram / rhyme are symmetric.
 */

// ---------- small helpers ----------

/** Same morphological family, near enough that pairing them makes a lame clue. */
export function sharesStem(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.startsWith(s) || l.endsWith(s)) return true;
  return a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4);
}

const addTo = (map, k, v) => {
  let set = map.get(k);
  if (!set) map.set(k, (set = new Set()));
  set.add(v);
};
const addSym = (map, a, b) => {
  if (a === b) return;
  addTo(map, a, b);
  addTo(map, b, a);
};

const letterMask = (w) => {
  let m = 0;
  for (let i = 0; i < w.length; i++) m |= 1 << (w.charCodeAt(i) - 97);
  return m;
};

/** x's letters appear in order inside y (plain subsequence; y strictly longer). */
export function isSubsequence(x, y) {
  if (x.length >= y.length) return false;
  let i = 0;
  for (let j = 0; j < y.length && i < x.length; j++) {
    if (x[i] === y[j]) i++;
  }
  return i === x.length;
}

const sortLetters = (w) => [...w].sort().join('');

// ---------- CMU pronouncing dictionary ----------

/** Parse cmudict.dict text → Map<word, Set<rhymeKey>>. Key = phonemes from the last
 *  primary-stressed vowel to the end (perfect-rhyme rule). Words with no primary
 *  stress (the, a, of…) get no key and so never rhyme. */
export function parseCmu(text) {
  const keys = new Map(); // primary pronunciation only — used for STRICT rhyme edges
  const keysAll = new Map(); // every variant — used for LIBERAL collision checks. Variants
  // like "most(2) M OW1 S" would otherwise make dose 'rhyme' with most.
  const prons = new Map(); // word -> Set of full pronunciation strings (homophone check)
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(';')) continue;
    const hash = line.indexOf('#');
    const clean = hash === -1 ? line : line.slice(0, hash);
    const t = clean.trim().split(/\s+/);
    if (t.length < 2) continue;
    const isVariant = /\(\d+\)$/.test(t[0]);
    const word = t[0].replace(/\(\d+\)$/, '');
    if (!/^[a-z]+$/.test(word)) continue;
    const phones = t.slice(1);
    let idx = -1;
    for (let i = phones.length - 1; i >= 0; i--) {
      if (phones[i].endsWith('1')) {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue;
    const key = phones.slice(idx).join(' ');
    if (!isVariant) addTo(keys, word, key);
    addTo(keysAll, word, key);
    addTo(prons, word, phones.join(' '));
  }
  return { keys, keysAll, prons };
}

// ---------- the graph ----------

/**
 * @param wn        loadWordNet() result
 * @param vocabRank Map<word, rank> — puzzle-eligible common words (lower rank = more common)
 * @param vLex      Set<word> — big validation lexicon for collision checking
 * @param cmu       parseCmu() result
 * @param sequencePairs  [[from, to], ...]
 */
export function buildGraph({ wn, vocabRank, vLex, cmu, sequencePairs, topSenses = 2 }) {
  const { synsets, senses, tagCounts, fileTotals } = wn;
  const okShape = (w) => /^[a-z]+$/.test(w) && w.length >= 3 && w.length <= 12;
  const inVocab = (w) => vocabRank.has(w);
  const inLex = (w) => vLex.has(w);

  // How frequent a sense is a synset for a given lemma (0 = its most common sense).
  const senseIndex = new Map();
  for (const [lemmaFile, keys] of senses) {
    const lemma = lemmaFile.slice(0, lemmaFile.indexOf('|'));
    keys.forEach((key, i) => {
      const id = `${lemma}|${key}`;
      const prev = senseIndex.get(id);
      if (prev === undefined || i < prev) senseIndex.set(id, i);
    });
  }
  const isTop = (lemma, key) => (senseIndex.get(`${lemma}|${key}`) ?? Infinity) < topSenses;
  const isTop1 = (lemma, key) => (senseIndex.get(`${lemma}|${key}`) ?? Infinity) < 1;

  /**
   * How much of a word's TOTAL tagged noun usage its most-common sense actually accounts
   * for. isTop1 alone only says a sense RANKS #1 among a word's own senses — for a highly
   * polysemous word (CASE has 20 noun senses, LINE has 30) the "winning" sense can still be
   * a weak plurality of real usage (case's top sense is only 44% of its total tags, line's
   * only 27%), which is exactly the pattern behind hypernym clues that are technically
   * WordNet-correct but read as arbitrary to a solver (CASE → TIME, LINE → RANK) — the
   * word's overwhelming everyday meaning is something else entirely. A tightly-focused word
   * (GOLF, WEATHER, DOG) has its dominant sense at 90-100%.
   */
  function senseDominance(lemma, key) {
    const top = tagCounts.get(`${lemma}|${key}`) ?? 0;
    const total = fileTotals.get(lemma)?.noun ?? 0;
    return { top, share: total > 0 ? top / total : 0 };
  }

  /**
   * Is this synset in a part of speech the lemma is actually used in? A strict clue may
   * use a word via a sense that was tagged at least once in the WordNet concordance, or
   * via its dominant POS. Kills cross-POS trivia like "even" the noun (= evening),
   * "flash" the adjective (= tastelessly showy) or "entire" the noun (= stallion).
   * Lemmas with no concordance data at all get a pass — absence of evidence only.
   */
  const posOk = (lemma, key) => {
    if ((tagCounts.get(`${lemma}|${key}`) ?? 0) >= 1) return true;
    const totals = fileTotals.get(lemma);
    if (!totals) return true;
    const sum = totals.noun + totals.verb + totals.adj + totals.adv;
    if (sum === 0) return true;
    const file = key.slice(0, key.indexOf('#'));
    return totals[file] === Math.max(totals.noun, totals.verb, totals.adj, totals.adv);
  };

  // Synsets no strict edge may touch (liberal collision checking still includes them):
  //  - named entities (instance-hypernym pointer) — encyclopedia trivia, not wordplay
  //    ("Centre is a region of France");
  //  - anything with a usage-domain pointer (;u) — slang, disparagement, trademarks…;
  //  - anything whose gloss flags it as offensive/slang. WordNet 3.1 marks the
  //    derogatory sense of "broad" only in its gloss ("slang term for a woman"), which
  //    once produced the clue "WOMAN is the category of BROAD". Never again.
  const BAD_GLOSS = /slang|offensive|disparag|derogat|ethnic slur|vulgar|obscen|pejorat|cursed?\b|profanit/i;
  const strictExcluded = new Set();
  for (const [key, s] of synsets) {
    if (
      s.pointers.some((p) => p.sym === '@i' || p.sym === ';u') ||
      BAD_GLOSS.test(s.gloss ?? '')
    ) {
      strictExcluded.add(key);
    }
  }

  // Liberal adjacency (collision checking) and strict edge list (puzzle building).
  const lib = {
    synonym: new Map(),
    antonym: new Map(),
    hyperDown: new Map(), // broader word -> narrower words
    hyperUp: new Map(),
    partsOf: new Map(), // whole -> parts
    wholesOf: new Map(), // part -> wholes
    seqNext: new Map(),
    seqPrev: new Map(),
    anagram: new Map(), // sortedLetters -> words
  };
  const strictSet = new Set(); // "type|from|to" dedupe
  const strictEdges = [];
  const byWord = new Map(); // word -> [{type, other, role: 'from'|'to'}]
  const addStrict = (type, from, to) => {
    let a = from;
    let b = to;
    const symmetric = type === 'synonym' || type === 'antonym' || type === 'anagram' || type === 'rhyme';
    if (symmetric && b < a) [a, b] = [b, a];
    const id = `${type}|${a}|${b}`;
    if (strictSet.has(id)) return;
    strictSet.add(id);
    strictEdges.push({ type, from: a, to: b });
    if (!byWord.has(a)) byWord.set(a, []);
    if (!byWord.has(b)) byWord.set(b, []);
    byWord.get(a).push({ type, other: b, role: 'from' });
    byWord.get(b).push({ type, other: a, role: 'to' });
  };

  const strictPairOk = (a, b) => inVocab(a) && inVocab(b) && !sharesStem(a, b);

  // --- synonyms (same synset, or adjective similar-to) + antonyms ---
  for (const [key, s] of synsets) {
    const ws = s.words.filter((w) => okShape(w) && inLex(w));
    const named = strictExcluded.has(key);
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        addSym(lib.synonym, ws[i], ws[j]);
        if (!named && strictPairOk(ws[i], ws[j]) && isTop(ws[i], key) && isTop(ws[j], key) && posOk(ws[i], key) && posOk(ws[j], key)) {
          addStrict('synonym', ws[i], ws[j]);
        }
      }
    }
    for (const ptr of s.pointers) {
      if (ptr.sym === '&') {
        const t = synsets.get(ptr.key);
        if (!t) continue;
        for (const a of ws) {
          for (const b of t.words) {
            if (!okShape(b) || !inLex(b) || a === b) continue;
            addSym(lib.synonym, a, b);
            // similar-to is only NEAR-synonymy — demand both words' single most
            // common sense, or clues like "graduate means same as high" sneak in
            if (!named && !strictExcluded.has(ptr.key) && strictPairOk(a, b) && isTop1(a, key) && isTop1(b, ptr.key) && posOk(a, key) && posOk(b, ptr.key)) addStrict('synonym', a, b);
          }
        }
      } else if (ptr.sym === '!') {
        const t = synsets.get(ptr.key);
        if (!t) continue;
        const a = s.words[parseInt(ptr.st.slice(0, 2), 16) - 1];
        const b = t.words[parseInt(ptr.st.slice(2), 16) - 1];
        if (!a || !b || !okShape(a) || !okShape(b) || !inLex(a) || !inLex(b)) continue;
        addSym(lib.antonym, a, b);
        if (!named && !strictExcluded.has(ptr.key) && strictPairOk(a, b) && isTop(a, key) && isTop(b, ptr.key) && posOk(a, key) && posOk(b, ptr.key)) addStrict('antonym', a, b);
      }
    }
  }

  // --- hypernyms ---

  // Overly-abstract categories make unsatisfying "category of" clues even when they're
  // technically correct in WordNet's ontology — "ACTION is the category of THING" is
  // true (thing has a rare sense meaning "an act"), but no solver reads that as a real
  // category. These sit at or near WordNet's ~25 noun "unique beginners" (the top of its
  // hierarchy) plus other near-root words that show up as a fallback whenever a word's
  // more specific hypernyms aren't common enough to be in vocab. Blocked outright,
  // regardless of sense frequency — the walk below stops rather than climbing past one.
  const GENERIC_HYPERNYMS = new Set([
    'thing', 'things', 'object', 'objects', 'entity', 'item', 'items', 'stuff', 'matter',
    'substance', 'material', 'way', 'ways', 'manner', 'kind', 'sort', 'type', 'form',
    'part', 'whole', 'unit', 'piece', 'element', 'aspect', 'attribute', 'property',
    'quality', 'feature', 'quantity', 'amount', 'measure', 'degree', 'extent', 'state',
    'condition', 'situation', 'event', 'occurrence', 'happening', 'incident', 'act',
    'action', 'activity', 'process', 'procedure', 'method', 'group', 'class', 'category',
    'collection', 'body', 'structure', 'system', 'relation', 'relationship', 'connection',
    'cognition', 'knowledge', 'communication', 'message', 'information', 'feeling',
    'emotion', 'sensation', 'experience', 'being', 'existence', 'phenomenon', 'artifact',
    'product', 'work', 'possession', 'change', 'issue', 'device', 'mass', 'lot', 'cost',
    'will', 'location', 'frequency', 'speech',
    'wise', // near-zero real usage as a noun (the archaic "in no wise") despite ranking #1 of its own barely-used senses
    'equipment', // as vague a mass-noun category as "stuff"/"material" (EQUIPMENT → SATELLITE)
  ]);

  // parentsStrict: real hypernyms only; parentsAll also includes instance hypernyms
  // (city → london) so proper-noun answers still count as collisions.
  const parentsStrict = new Map();
  const parentsAll = new Map();
  for (const [key, s] of synsets) {
    for (const ptr of s.pointers) {
      if (ptr.sym === '@') {
        addTo(parentsStrict, key, ptr.key);
        addTo(parentsAll, key, ptr.key);
      } else if (ptr.sym === '@i') {
        addTo(parentsAll, key, ptr.key);
      }
    }
  }
  const lexWords = (key) => (synsets.get(key)?.words ?? []).filter((w) => okShape(w) && inLex(w));
  const vocabWords = (key) => lexWords(key).filter(inVocab);

  // Liberal: every word-bearing ancestor within 4 hops counts.
  for (const [key] of synsets) {
    const downWords = lexWords(key);
    if (downWords.length === 0) continue;
    const seen = new Set();
    const walk = (k, depth) => {
      if (depth > 4) return;
      for (const p of parentsAll.get(k) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        for (const up of lexWords(p)) {
          for (const down of downWords) {
            if (up === down) continue;
            addTo(lib.hyperDown, up, down);
            addTo(lib.hyperUp, down, up);
          }
        }
        walk(p, depth + 1);
      }
    };
    walk(key, 1);
  }

  // Strict: NOUN synsets only (verb hypernym chains read as nonsense clues — "HAVE is
  // the category of STAR"), nearest vocab-word-bearing ancestors only (skipping through
  // synsets whose lemmas are all multiword/rare, e.g. husky → {working dog} → dog).
  // Collected into a candidate list first (rather than committed straight to addStrict)
  // so the fan-out pass below can also drop up-words that turn out to be hubs for
  // dozens of unrelated vocab words — a computed second line of defense alongside the
  // hand-curated GENERIC_HYPERNYMS list, catching generic words that list missed.
  // A rare secondary sense on EITHER side is where most of the truly odd pairings came
  // from (ACTION → THING used thing's "an act" sense; QUALITY → GOOD used good's rare
  // noun sense) — so both ends now require their single MOST common sense (isTop1), not
  // just a top-2 one. This drops volume noticeably but that's the point: fewer, better.
  //
  // isTop1 alone still wasn't enough: it only requires RANKING #1 among a word's own
  // senses, which a highly polysemous word can satisfy with a weak plurality (CASE's
  // "instance" sense is its top sense yet only 44% of its total tagged usage; LINE's
  // "formation" sense only 27%) — exactly the pattern behind CASE→TIME, LINE→RANK. So the
  // UP (broader/category) word additionally needs real absolute usage evidence AND to
  // dominate its own senses outright, not just edge out a crowd of near-equal rivals —
  // solvers read the up-word cold, with no context to disambiguate a weak-plurality sense.
  const MIN_HYPERNYM_TAG = 2; // kills zero/near-zero-evidence nouns (e.g. "using")
  const MIN_UP_DOMINANCE_SHARE = 0.45; // up-word's matched sense vs. its OWN total usage
  // WordNet groups every noun sense into a "lexicographer file" by broad semantic class.
  // Hypernym clues only read as obvious ("a ROSE is a FLOWER") when BOTH words sit in a
  // CONCRETE class — a tangible kind of thing. The abstract classes (communication,
  // cognition, act, attribute, state, relation, …) are where WordNet's technically-correct
  // -but-ridiculous categories live (TERM→WORD, CONCEPT→VALUE, BUYING→PURCHASE, CONTROL→
  // POWER). noun.person is excluded too: its categories are either generic (AUTHOR→PERSON,
  // ADULT→TEACHER) or occupational jargon, never a crisp "kind of". Gating strict hypernym
  // edges to these files structurally removes that whole class of bad clue. The LIBERAL
  // hypernym graph below is deliberately NOT gated — a solver might well think of an
  // abstract category, so uniqueness checking must still see them.
  const CONCRETE_NOUN_LEXNOS = new Set([
    5,  // noun.animal
    6,  // noun.artifact
    8,  // noun.body
    13, // noun.food
    17, // noun.object (natural objects: rock, star, hill…)
    20, // noun.plant
    27, // noun.substance
  ]);
  const isConcreteSynset = (k) => CONCRETE_NOUN_LEXNOS.has(synsets.get(k)?.lexno);
  const hypernymCandidates = [];
  for (const [key, s] of synsets) {
    if (!key.startsWith('noun#') || strictExcluded.has(key)) continue;
    if (!isConcreteSynset(key)) continue; // hyponym must itself be a concrete kind of thing
    // GENERIC_HYPERNYMS is excluded on the down side too, not just up — a word being a
    // bad, uninformative *category* has nothing to do with which side of the clue it sits
    // on. ("wise" as a down-word slipped through the tag-count floor purely because ALL
    // of its evidence — exactly 2 tags — sits in this one archaic "in no wise" sense, so
    // it looked "100% dominant"; the floor can't distinguish a genuinely rare-but-real
    // word from one with almost no real evidence at all. The blocklist can.)
    const downWords = s.words.filter(
      (w) =>
        okShape(w) &&
        inVocab(w) &&
        isTop1(w, key) &&
        posOk(w, key) &&
        !GENERIC_HYPERNYMS.has(w) &&
        (tagCounts.get(`${w}|${key}`) ?? 0) >= MIN_HYPERNYM_TAG
    );
    if (downWords.length === 0) continue;
    const seen = new Set();
    const walk = (k, depth) => {
      if (depth > 3) return;
      for (const p of parentsStrict.get(k) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        // An abstract ancestor is never a good category, and everything above it is only
        // more abstract — so stop this branch rather than climbing past it.
        if (!isConcreteSynset(p)) continue;
        const rawUps = strictExcluded.has(p) ? [] : vocabWords(p).filter((w) => isTop1(w, p) && posOk(w, p));
        const ups = rawUps.filter((w) => {
          if (GENERIC_HYPERNYMS.has(w)) return false;
          const { top, share } = senseDominance(w, p);
          return top >= MIN_HYPERNYM_TAG && share >= MIN_UP_DOMINANCE_SHARE;
        });
        if (ups.length > 0) {
          for (const up of ups) {
            for (const down of downWords) {
              if (!sharesStem(up, down)) hypernymCandidates.push({ up, down });
            }
          }
        } else if (rawUps.length === 0) {
          walk(p, depth + 1); // nothing lexicalized at all here — keep climbing
        }
        // else: rawUps was non-empty but entirely generic — stop; anything further up
        // the hierarchy is even MORE abstract, never less, so climbing past it can only
        // find another (possibly unlisted) generic word, never a useful specific one.
      }
    };
    walk(key, 1);
  }

  // Fan-out is logged for visibility but NOT capped by size alone: legitimate large
  // categories (PERSON is the hypernym of every occupation noun — author, dealer,
  // teacher — well over 100 of them) are exactly as satisfying a clue at high fan-out as
  // low. What made the earlier bad clues (ACTION→THING, QUALITY→GOOD) bad wasn't their
  // low fan-out, it was a rare secondary WordNet sense — fixed above via isTop1. This
  // cap is a dead-man's-switch for a genuine runaway hub the curated list hasn't caught.
  const MAX_HYPERNYM_FANOUT = 250;
  const hyperFanOut = new Map();
  for (const { up, down } of hypernymCandidates) addTo(hyperFanOut, up, down);
  {
    const broadest = [...hyperFanOut.entries()]
      .map(([up, downs]) => [up, downs.size])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    console.log('  broadest hypernym up-words:', broadest.map(([w, n]) => `${w}(${n})`).join(', '));
  }
  for (const { up, down } of hypernymCandidates) {
    if ((hyperFanOut.get(up)?.size ?? 0) <= MAX_HYPERNYM_FANOUT) addStrict('hypernym', up, down);
  }

  // --- meronyms (part/member for strict; + substance for liberal) ---
  for (const [key, s] of synsets) {
    const here = lexWords(key);
    for (const ptr of s.pointers) {
      const strictSym = ptr.sym === '%p' || ptr.sym === '%m';
      const liberalSym = strictSym || ptr.sym === '%s' || ptr.sym === '#p' || ptr.sym === '#m' || ptr.sym === '#s';
      if (!liberalSym) continue;
      const there = lexWords(ptr.key);
      // % pointers: target is a part of source (whole = here). # pointers: inverse.
      const isMeronymPtr = ptr.sym.startsWith('%');
      const wholes = isMeronymPtr ? here : there;
      const parts = isMeronymPtr ? there : here;
      const named = strictExcluded.has(key) || strictExcluded.has(ptr.key);
      for (const whole of wholes) {
        for (const part of parts) {
          if (part === whole) continue;
          addTo(lib.partsOf, whole, part);
          addTo(lib.wholesOf, part, whole);
          const partKey = isMeronymPtr ? ptr.key : key;
          const wholeKey = isMeronymPtr ? key : ptr.key;
          if (strictSym && !named && strictPairOk(part, whole) && isTop1(part, partKey) && isTop1(whole, wholeKey) && posOk(part, partKey) && posOk(whole, wholeKey)) {
            addStrict('meronym', part, whole);
          }
        }
      }
    }
  }

  // --- sequences (curated, closed list: liberal == strict) ---
  for (const [from, to] of sequencePairs) {
    if (!okShape(from) || !okShape(to)) continue;
    addTo(lib.seqNext, from, to);
    addTo(lib.seqPrev, to, from);
    if (inVocab(from) && inVocab(to)) addStrict('sequence', from, to);
  }

  // --- anagrams ---
  for (const w of vLex) {
    if (okShape(w)) addTo(lib.anagram, sortLetters(w), w);
  }
  for (const [, group] of lib.anagram) {
    if (group.size < 2) continue;
    const arr = [...group];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (strictPairOk(arr[i], arr[j])) addStrict('anagram', arr[i], arr[j]);
      }
    }
  }

  // --- rhymes ---
  const rhymeGroups = new Map(); // primary-pron groups (strict edges)
  for (const [word, keys] of cmu.keys) {
    if (!inLex(word) || !okShape(word)) continue;
    for (const k of keys) addTo(rhymeGroups, k, word);
  }
  const rhymeGroupsAll = new Map(); // variant-inclusive groups (liberal collision checks)
  for (const [word, keys] of cmu.keysAll) {
    if (!inLex(word) || !okShape(word)) continue;
    for (const k of keys) addTo(rhymeGroupsAll, k, word);
  }
  const samePron = (a, b) => {
    const pa = cmu.prons.get(a);
    const pb = cmu.prons.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };
  for (const [, group] of rhymeGroups) {
    if (group.size < 2) continue;
    const arr = [...group].filter(inVocab);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        if (sharesStem(a, b)) continue; // catches light/slight, nation/carnation-style suffixes
        if (samePron(a, b)) continue; // homophones aren't rhymes
        addStrict('rhyme', a, b);
      }
    }
  }

  // --- strict lettersubset edges (for building; collision checks scan on demand) ---
  const vocabByLen = new Map();
  for (const w of vocabRank.keys()) {
    if (!okShape(w)) continue;
    if (!vocabByLen.has(w.length)) vocabByLen.set(w.length, []);
    vocabByLen.get(w.length).push(w);
  }
  const masks = new Map();
  for (const w of vLex) masks.set(w, letterMask(w));
  const hidesNicely = (x, y) =>
    y.length >= x.length + 2 && !y.startsWith(x) && !y.endsWith(x) && isSubsequence(x, y);
  for (let ls = 4; ls <= 7; ls++) {
    for (const x of vocabByLen.get(ls) ?? []) {
      const mx = masks.get(x);
      for (let ll = ls + 2; ll <= 9; ll++) {
        for (const y of vocabByLen.get(ll) ?? []) {
          if ((mx & ~masks.get(y)) !== 0) continue;
          if (sharesStem(x, y)) continue;
          if (hidesNicely(x, y)) addStrict('lettersubset', x, y);
        }
      }
    }
  }

  // ---------- liberal candidate enumeration (uniqueness checking) ----------

  const lexByLen = new Map();
  for (const w of vLex) {
    if (!okShape(w)) continue;
    if (!lexByLen.has(w.length)) lexByLen.set(w.length, []);
    lexByLen.get(w.length).push(w);
  }
  const rhymeKeysOf = (w) => cmu.keysAll.get(w) ?? new Set();

  /**
   * All lexicon words of length `len` that could fill a hidden slot, given one clue:
   * the known word, its role in the link ('from'/'to'), and the link type. Deliberately
   * generous — used to REJECT puzzles with lookalike answers.
   */
  const candCache = new Map();
  function liberalCandidates(type, known, knownRole, len) {
    const cacheKey = `${type}|${known}|${knownRole}|${len}`;
    const hit = candCache.get(cacheKey);
    if (hit) return hit;
    let base;
    switch (type) {
      case 'synonym':
        base = lib.synonym.get(known);
        break;
      case 'antonym':
        base = lib.antonym.get(known);
        break;
      case 'hypernym':
        base = knownRole === 'from' ? lib.hyperDown.get(known) : lib.hyperUp.get(known);
        break;
      case 'meronym':
        base = knownRole === 'from' ? lib.wholesOf.get(known) : lib.partsOf.get(known);
        break;
      case 'sequence':
        base = knownRole === 'from' ? lib.seqNext.get(known) : lib.seqPrev.get(known);
        break;
      case 'anagram':
        base = lib.anagram.get(sortLetters(known));
        break;
      case 'rhyme': {
        base = new Set();
        for (const k of rhymeKeysOf(known)) {
          for (const w of rhymeGroupsAll.get(k) ?? []) base.add(w);
        }
        break;
      }
      case 'lettersubset': {
        // Pure player-facing rule here (any subsequence), no aesthetic filters.
        base = new Set();
        const mk = masks.get(known) ?? letterMask(known);
        for (const w of lexByLen.get(len) ?? []) {
          if (knownRole === 'from') {
            if ((mk & ~(masks.get(w) ?? 0)) === 0 && isSubsequence(known, w)) base.add(w);
          } else if (((masks.get(w) ?? 0) & ~mk) === 0 && isSubsequence(w, known)) {
            base.add(w);
          }
        }
        break;
      }
      default:
        base = new Set();
    }
    const out = new Set();
    for (const w of base ?? []) {
      if (w.length === len && w !== known) out.add(w);
    }
    candCache.set(cacheKey, out);
    return out;
  }

  /** Liberal yes/no: could a solver defend `from —type→ to`? */
  function liberalPair(type, from, to) {
    switch (type) {
      case 'synonym':
        return lib.synonym.get(from)?.has(to) ?? false;
      case 'antonym':
        return lib.antonym.get(from)?.has(to) ?? false;
      case 'hypernym':
        return lib.hyperDown.get(from)?.has(to) ?? false;
      case 'meronym':
        return lib.wholesOf.get(from)?.has(to) ?? false;
      case 'sequence':
        return lib.seqNext.get(from)?.has(to) ?? false;
      case 'anagram':
        return from !== to && sortLetters(from) === sortLetters(to);
      case 'rhyme': {
        const ka = rhymeKeysOf(from);
        for (const k of rhymeKeysOf(to)) if (ka.has(k)) return true;
        return false;
      }
      case 'lettersubset':
        return isSubsequence(from, to);
      default:
        return false;
    }
  }

  return { strictEdges, byWord, liberalCandidates, liberalPair };
}
