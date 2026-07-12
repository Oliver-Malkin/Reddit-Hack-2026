/**
 * Minimal WordNet 3.0 database parser, reading the dict files shipped by the
 * `wordnet-db` npm package. Produces:
 *  - synsets: Map<"<file>#<offset>", { words: string[], pointers: {sym, key, st}[] }>
 *  - senses:  Map<"<lemma>|<file>", string[]>  — synset keys ordered most-frequent-first
 *             (WordNet index files list a lemma's synsets by sense frequency).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DICT_DIR = require('wordnet-db').path;

const POS_FILES = ['noun', 'verb', 'adj', 'adv'];
// Pointer pos chars map to the data file the target offset lives in ('s' = adj satellite).
const FILE_OF = { n: 'noun', v: 'verb', a: 'adj', s: 'adj', r: 'adv' };

/** Lowercase and strip adjective syntax markers like "beautiful(p)". */
const cleanWord = (w) => w.toLowerCase().replace(/\([a-z]+\)$/, '');

export function loadWordNet() {
  const synsets = new Map();
  const senses = new Map();
  // From index.sense: how often each (lemma, synset) was tagged in the semantic
  // concordance, plus per-POS totals per lemma. Lets callers reject edges that use a
  // word in a POS it essentially never has ("even" as a noun meaning evening).
  const tagCounts = new Map(); // `${lemma}|${file}#${offset}` -> count
  const fileTotals = new Map(); // lemma -> { noun, verb, adj, adv }
  const SS_FILE = { 1: 'noun', 2: 'verb', 3: 'adj', 4: 'adv', 5: 'adj' };
  const senseText = readFileSync(join(DICT_DIR, 'index.sense'), 'utf8');
  for (const line of senseText.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const pct = t[0].indexOf('%');
    if (pct === -1) continue;
    const lemma = t[0].slice(0, pct);
    const file = SS_FILE[t[0][pct + 1]];
    if (!file) continue;
    const cnt = parseInt(t[3], 10) || 0;
    const key = `${lemma}|${file}#${t[1]}`;
    tagCounts.set(key, (tagCounts.get(key) ?? 0) + cnt);
    let totals = fileTotals.get(lemma);
    if (!totals) fileTotals.set(lemma, (totals = { noun: 0, verb: 0, adj: 0, adv: 0 }));
    totals[file] += cnt;
  }

  for (const file of POS_FILES) {
    const dataText = readFileSync(join(DICT_DIR, `data.${file}`), 'utf8');
    for (const line of dataText.split('\n')) {
      if (!line || line.startsWith(' ')) continue; // license header lines start with spaces
      const [head, gloss = ''] = line.split(' | ');
      const t = head.trim().split(/\s+/);
      const offset = t[0];
      const wCnt = parseInt(t[3], 16); // word count is 2-digit hex
      let i = 4;
      const words = [];
      for (let w = 0; w < wCnt; w++, i += 2) words.push(cleanWord(t[i]));
      const pCnt = parseInt(t[i], 10);
      i++;
      const pointers = [];
      for (let p = 0; p < pCnt; p++, i += 4) {
        pointers.push({
          sym: t[i], // pointer symbol: @ hypernym, ! antonym, %p part meronym, & similar, ...
          key: `${FILE_OF[t[i + 2]]}#${t[i + 1]}`,
          st: t[i + 3], // 4 hex digits: source|target word numbers (0000 = synset-to-synset)
        });
      }
      synsets.set(`${file}#${offset}`, { words, pointers, gloss });
    }

    const idxText = readFileSync(join(DICT_DIR, `index.${file}`), 'utf8');
    for (const line of idxText.split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      const t = line.trim().split(/\s+/);
      const lemma = t[0];
      const pCnt = parseInt(t[3], 10);
      // lemma pos synset_cnt p_cnt [ptr_symbol...] sense_cnt tagsense_cnt offset...
      const offsets = t.slice(4 + pCnt + 2).map((o) => `${file}#${o}`);
      senses.set(`${lemma}|${file}`, offsets);
    }
  }
  return { synsets, senses, tagCounts, fileTotals };
}
