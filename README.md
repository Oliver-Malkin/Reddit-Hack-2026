# WordFish

A daily word-chain puzzle for Reddit, built on [Devvit](https://developers.reddit.com/) with [Phaser](https://phaser.io/).

Each puzzle is a short chain of words connected by wordplay — synonyms, antonyms, hypernyms, anagrams, hidden letters, rhymes. One or more words in the chain are hidden behind "?" tiles, and you have to work out what they are from how they connect to the words around them. A single word can relate to its neighbors in two completely different ways at once, which is where most of the "aha" comes from — e.g. a word that's a synonym of the word before it and an anagram of the word after it.

## How to play

1. Open today's WordFish post on Reddit — the puzzle loads straight in the post, no install or login needed.
2. You'll see a chain of word tiles. Some show a full word; others show blank "?" letter tiles.
3. Each pair of neighboring words in the chain is connected by a relationship (synonym, antonym, hypernym, meronym, anagram, shared-letters, rhyme). Tap a blank tile's row to select it, then type your guess.
4. Work out each hidden word from how it relates to the word(s) next to it — the same hidden word is often linked to its neighbors in two different ways at once, so a wrong first guess is a clue, not a dead end.
5. Fill in every hidden word to solve the chain. Get it wrong and the tiles will let you know; get it right and move on to the next difficulty, or come back tomorrow for a new one.
6. Want to make your own? Open the puzzle editor to build a chain of your own words and links and publish it as a new Reddit post for others to solve.

## What it does

- **A new puzzle every day**, playable directly inside a Reddit post — no app install, no account.
- **Chain-based clues**: words link to each other via typed relationships (synonym, antonym, hypernym, meronym, anagram, letter-subset, rhyme, sequence), and you deduce hidden words from the links touching them.
- **A puzzle editor**: players can build and publish their own chains, which get posted to the subreddit as new, independently playable puzzles — the daily puzzle isn't the only content, the community can keep making more.
- Two difficulty tiers per day (easy / hard) so both casual and hardcore solvers have something to chase.

## How it's built

- **Devvit Web** app — a Hono server (`src/server`) running as the post's backend, talking to a Phaser client (`src/client`) over a small typed API (`src/shared/api.ts`).
- **Phaser** drives the entire play surface: draggable letter tiles, animated rope-like connectors between words, procedurally synthesized sound effects (no audio files — everything is generated via the Web Audio API), and a tutorial/coach layer for first-time players.
- Puzzles are plain data (`src/shared/puzzle.ts`): a list of words plus typed links between them, with a subset marked `hidden`. The client renders hidden words as letter tiles and the player fills them in; the server validates community submissions (link coverage, size limits, basic content moderation) before turning them into real Reddit posts.
- **Daily puzzles are machine-generated** (`scripts/puzzlegen/`): an offline pipeline builds a word-relation graph over the ~8k most common English words — WordNet for synonyms/antonyms/hypernyms/meronyms, the CMU pronouncing dictionary for rhymes, computed letterplay for anagrams and hidden-letter chains, and a hand-curated list for "becomes" sequences. It assembles known–hidden–known chains (easy) and known–hidden–hidden–known chains (hard), rejects any puzzle where a second word in a ~73k-word lexicon also fits all the clues at the answer's length, scores the survivors for fun (a meaning clue crossed with a letterplay clue scores highest), and commits a 120+120 bank to `src/client/puzzle/puzzleBank.ts`. The client steps through the pre-shuffled bank by UTC day. Regenerate with `npm run generate:puzzles` and review `scripts/puzzlegen/report.txt`.
- State for community-submitted puzzles is stored in Redis, keyed by the post ID that hosts them, so each published puzzle is a self-contained post anyone can open and solve.

## Project layout

```
src/
  client/     Phaser game: scenes, puzzle rendering, tile/chain visuals, puzzle editor
  server/     Hono API + Devvit triggers/menu actions, puzzle storage, moderation
  shared/     Puzzle data model and API types shared between client and server
```

## Local development

Run the Phaser client directly in a browser, without needing Devvit auth:

```
npx vite src/client
```
