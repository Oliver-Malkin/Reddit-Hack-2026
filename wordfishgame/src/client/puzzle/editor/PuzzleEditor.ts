/**
 * The "Create a Puzzle" editor — a full-screen DOM overlay (not a Phaser scene) themed to
 * match the game's Memphis look: off-white ground, thick ink borders, chunky offset shadows,
 * bold accent colours, tactile press feedback.
 *
 * DOM (rather than canvas) because this screen is almost entirely text fields and dropdowns,
 * which are painful and ugly to build in Phaser and genuinely better as native inputs. It
 * has no hard Devvit dependency, so it works in the local `vite src/client` preview:
 *  - PREVIEW builds the puzzle and hands it to PuzzleScene (fully offline, real render path).
 *  - PUBLISH POSTs to the server; offline that fails gracefully to an inline message.
 *
 * The creator adds words, tags each CLUE or HIDDEN (hidden = the answer to solve), then links
 * pairs of words and picks the relationship (synonym, anagram, …). That is exactly the
 * `Puzzle` shape the rest of the game already renders.
 */

import { PALETTE, UI_FONT, cssColor } from '../../theme';
import { LINK_TYPES } from '../types';
import type { LinkType, Puzzle } from '../types';
import { navigateToPost, publishPuzzle } from '../remote';
import { findBlockedTerm } from '../../../shared/moderation';

export type PuzzleEditorCallbacks = {
  /** Preview the built puzzle now. Returns whether the scenes actually swapped — only then
   *  does the overlay HIDE itself (not destroy, so the creator can return to their form
   *  untouched via showPuzzleEditor()). A refused swap keeps the overlay up. */
  onPreview: (puzzle: Puzzle, title: string) => boolean;
  /** The editor was dismissed with no puzzle previewed. */
  onClose: () => void;
};

type WordDraft = { id: string; text: string; hidden: boolean };
type LinkDraft = { id: string; type: LinkType; from: string; to: string };

const STYLE_ID = 'wf-editor-style';

/** Board layout assumes a small chain — beyond this the puzzle gets unreadably cramped. */
const MAX_WORDS = 6;

// The single live editor. Kept alive (hidden) while previewing so the form's contents
// survive a trip to the board and back.
let liveEditor: PuzzleEditor | null = null;

// The last unpublished draft, saved when the editor closes and restored on reopen — an
// accidental back-tap must not eat a half-built puzzle. Cleared once a puzzle is published.
type EditorDraft = { words: WordDraft[]; links: LinkDraft[]; title: string; idSeq: number };
let savedDraft: EditorDraft | null = null;

/** Open the editor overlay. Only one exists at a time — if a live editor already exists
 *  (possibly hidden mid-preview), it is re-shown with its form intact rather than silently
 *  doing nothing, so a stranded overlay is always recoverable. */
export function openPuzzleEditor(cb: PuzzleEditorCallbacks): void {
  if (liveEditor) {
    liveEditor.show();
    return;
  }
  liveEditor = new PuzzleEditor(cb);
}

/** Re-show the hidden editor after a preview. Returns false if there's no live editor. */
export function showPuzzleEditor(): boolean {
  if (!liveEditor) return false;
  liveEditor.show();
  return true;
}

class PuzzleEditor {
  private root: HTMLDivElement;
  private wordListEl!: HTMLDivElement;
  private linkListEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private titleInput!: HTMLInputElement;
  private words: WordDraft[] = [];
  private links: LinkDraft[] = [];
  private idSeq = 0;
  private closed = false;
  private published = false;

  constructor(private cb: PuzzleEditorCallbacks) {
    injectStyle();
    // Pick up where an accidental close left off; otherwise start the seeded blank chain.
    if (savedDraft) this.restore(savedDraft);
    else this.seed();

    this.root = document.createElement('div');
    this.root.id = 'wf-editor-root';
    this.root.className = 'wf-editor';
    this.root.innerHTML = this.shell();
    document.body.appendChild(this.root);

    this.wordListEl = this.q('.wf-word-list');
    this.linkListEl = this.q('.wf-link-list');
    this.errorEl = this.q('.wf-ed-error');
    this.titleInput = this.q('.wf-title-input');
    if (savedDraft) this.titleInput.value = savedDraft.title;

    this.q('.wf-back').addEventListener('click', () => this.close());
    this.q('.wf-add-word').addEventListener('click', () => {
      if (this.words.length >= MAX_WORDS) {
        this.showError(`A puzzle can have at most ${MAX_WORDS} words.`);
        return;
      }
      this.words.push(this.newWord(false));
      this.renderWords();
      this.renderLinks();
      // Put the cursor straight in the new word — no second tap needed.
      const inputs = this.wordListEl.querySelectorAll<HTMLInputElement>('.wf-input');
      const last = inputs[inputs.length - 1];
      last?.focus();
      last?.scrollIntoView({ block: 'nearest' });
    });
    this.q('.wf-add-link').addEventListener('click', () => {
      if (this.words.length < 2) {
        this.showError('Add at least two words before linking them.');
        return;
      }
      this.links.push(this.newLink());
      this.renderLinks();
    });
    this.q('.wf-preview').addEventListener('click', () => this.preview());
    this.q('.wf-publish').addEventListener('click', () => void this.publish());

    this.renderWords();
    this.renderLinks();

    // Fade in. A forced style flush (not rAF) guarantees the browser commits the initial
    // opacity:0 before the class flips it, so the fade always runs — rAF can be delayed by
    // a heavy Phaser frame, which made the card pop in and visibly jump instead.
    void this.root.offsetHeight;
    this.root.classList.add('wf-open');
  }

  // ---------- initial content ----------

  /** A blank three-word chain (clue → HIDDEN → clue) with two links pre-wired, so the shape
   *  of a puzzle is obvious at a glance; the creator just fills in words + picks link types. */
  private seed() {
    const a = this.newWord(false);
    const b = this.newWord(true);
    const c = this.newWord(false);
    this.words = [a, b, c];
    this.links = [
      { id: this.nextId('l'), type: 'synonym', from: a.id, to: b.id },
      { id: this.nextId('l'), type: 'synonym', from: b.id, to: c.id },
    ];
  }

  /** Rehydrate a previously-closed draft (deep-copied so the saved snapshot stays pristine
   *  if this session is abandoned mid-edit too). */
  private restore(draft: EditorDraft) {
    this.words = draft.words.map((w) => ({ ...w }));
    this.links = draft.links.map((l) => ({ ...l }));
    this.idSeq = draft.idSeq;
  }

  private newWord(hidden: boolean): WordDraft {
    return { id: this.nextId('w'), text: '', hidden };
  }

  private newLink(): LinkDraft {
    const from = this.words[0]?.id ?? '';
    const to = this.words[1]?.id ?? '';
    return { id: this.nextId('l'), type: 'synonym', from, to };
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}${this.idSeq}`;
  }

  // ---------- rendering ----------

  private renderWords() {
    this.wordListEl.replaceChildren(...this.words.map((w, i) => this.wordRow(w, i)));
    const addBtn = this.q<HTMLButtonElement>('.wf-add-word');
    const atCap = this.words.length >= MAX_WORDS;
    addBtn.disabled = atCap;
    addBtn.textContent = atCap ? `MAX ${MAX_WORDS} WORDS` : '+ ADD WORD';
  }

  private wordRow(word: WordDraft, index: number): HTMLElement {
    const row = el('div', 'wf-row wf-word');

    const input = el('input', 'wf-input') as HTMLInputElement;
    input.type = 'text';
    input.value = word.text;
    input.maxLength = 16;
    input.placeholder = word.hidden ? 'HIDDEN ANSWER' : `CLUE WORD ${index + 1}`;
    input.setAttribute('aria-label', 'Word');
    input.addEventListener('input', () => {
      word.text = input.value.toUpperCase();
      input.value = word.text;
      this.refreshLinkOptions();
      this.clearError();
    });
    // Enter hops to the next word (dismissing the phone keyboard on the last one) — fill
    // the whole list without reaching for the screen between words.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const inputs = [...this.wordListEl.querySelectorAll<HTMLInputElement>('.wf-input')];
      const next = inputs[inputs.indexOf(input) + 1];
      if (next) next.focus();
      else input.blur();
    });
    row.appendChild(input);

    // CLUE | HIDDEN segmented toggle.
    const seg = el('div', 'wf-seg');
    const clueBtn = el('button', 'wf-seg-btn');
    clueBtn.textContent = 'CLUE';
    const hiddenBtn = el('button', 'wf-seg-btn');
    hiddenBtn.textContent = 'HIDDEN';
    const syncSeg = () => {
      clueBtn.classList.toggle('wf-on', !word.hidden);
      hiddenBtn.classList.toggle('wf-on', word.hidden);
      input.placeholder = word.hidden ? 'HIDDEN ANSWER' : `CLUE WORD ${index + 1}`;
    };
    clueBtn.addEventListener('click', () => {
      word.hidden = false;
      syncSeg();
      this.clearError();
    });
    hiddenBtn.addEventListener('click', () => {
      word.hidden = true;
      syncSeg();
      this.clearError();
    });
    syncSeg();
    seg.append(clueBtn, hiddenBtn);
    row.appendChild(seg);

    const del = el('button', 'wf-del');
    del.textContent = '×';
    del.setAttribute('aria-label', 'Remove word');
    del.addEventListener('click', () => {
      this.words = this.words.filter((w) => w.id !== word.id);
      // Drop any link that referenced the removed word.
      this.links = this.links.filter((l) => l.from !== word.id && l.to !== word.id);
      this.renderWords();
      this.renderLinks();
      this.clearError();
    });
    row.appendChild(del);

    return row;
  }

  private renderLinks() {
    if (this.links.length === 0) {
      const empty = el('div', 'wf-empty');
      empty.textContent = 'No links yet — add one to connect two words.';
      this.linkListEl.replaceChildren(empty);
      return;
    }
    this.linkListEl.replaceChildren(...this.links.map((l) => this.linkRow(l)));
  }

  private linkRow(link: LinkDraft): HTMLElement {
    const row = el('div', 'wf-row wf-link');

    const fromSel = this.wordSelect(link.from);
    fromSel.addEventListener('change', () => (link.from = fromSel.value));

    const typeSel = el('select', 'wf-select wf-type') as HTMLSelectElement;
    const syncTypeHint = () => {
      typeSel.title = LINK_TYPES.find((t) => t.type === link.type)?.hint ?? '';
    };
    for (const { type, label, hint } of LINK_TYPES) {
      const opt = el('option') as HTMLOptionElement;
      opt.value = type;
      opt.textContent = label;
      opt.title = hint;
      if (type === link.type) opt.selected = true;
      typeSel.appendChild(opt);
    }
    syncTypeHint();
    typeSel.addEventListener('change', () => {
      link.type = typeSel.value as LinkType;
      syncTypeHint();
    });

    // The row reads as a sentence — WORD · relation → WORD. The arrow shows which way a
    // directional link points; swap the two words to reverse it.
    const arrow = el('span', 'wf-arrow');
    arrow.textContent = '→';

    const toSel = this.wordSelect(link.to);
    toSel.addEventListener('change', () => (link.to = toSel.value));

    const del = el('button', 'wf-del');
    del.textContent = '×';
    del.setAttribute('aria-label', 'Remove link');
    del.addEventListener('click', () => {
      this.links = this.links.filter((l) => l.id !== link.id);
      this.renderLinks();
      this.clearError();
    });

    row.append(fromSel, typeSel, arrow, toSel, del);
    return row;
  }

  private wordSelect(selectedId: string): HTMLSelectElement {
    const sel = el('select', 'wf-select wf-word-select') as HTMLSelectElement;
    this.words.forEach((w, i) => {
      const opt = el('option') as HTMLOptionElement;
      opt.value = w.id;
      opt.textContent = w.text || `Word ${i + 1}`;
      if (w.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  /** Refresh the option labels/values in every link's word dropdowns after a word edit,
   *  keeping each link's current from/to selection where still valid. */
  private refreshLinkOptions() {
    this.renderLinks();
  }

  // ---------- build / validate ----------

  private buildPuzzle(): { ok: true; puzzle: Puzzle } | { ok: false; message: string } {
    const words = this.words.map((w) => ({ ...w, text: w.text.trim() }));
    if (words.length < 2) return fail('Add at least two words.');
    if (words.length > MAX_WORDS) return fail(`A puzzle can have at most ${MAX_WORDS} words.`);
    for (const w of words) {
      if (w.text.length === 0) return fail('Every word needs some text.');
      if (!/^[A-Z]+$/.test(w.text)) return fail(`"${w.text || '?'}" must be letters only.`);
    }
    if (!words.some((w) => w.hidden)) {
      return fail('Mark at least one word as HIDDEN — that is the answer players solve.');
    }
    if (this.links.length === 0) return fail('Add at least one link between two words.');

    const ids = new Set(words.map((w) => w.id));
    const touched = new Set<string>();
    for (const l of this.links) {
      if (!l.from || !l.to || !ids.has(l.from) || !ids.has(l.to)) {
        return fail('Every link needs two words chosen.');
      }
      if (l.from === l.to) return fail('A link must join two different words.');
      touched.add(l.from);
      touched.add(l.to);
    }
    for (const w of words) {
      if (!touched.has(w.id)) return fail(`"${w.text}" is not linked to anything yet.`);
    }

    const puzzle: Puzzle = {
      words: words.map((w) => (w.hidden ? { id: w.id, text: w.text, hidden: true } : { id: w.id, text: w.text })),
      links: this.links.map((l) => ({ type: l.type, from: l.from, to: l.to })),
    };
    return { ok: true, puzzle };
  }

  private title(): string {
    return this.titleInput.value.trim();
  }

  // ---------- actions ----------

  private preview() {
    const built = this.buildPuzzle();
    if (!built.ok) return this.showError(built.message);
    const title = this.title() || 'My puzzle';
    // Order matters: the callback JUMPS the scenes underneath first (board snaps into
    // place behind this still-covering overlay), THEN the overlay fades out over it —
    // so the reveal is a clean crossfade to the board, never a glimpse of the menu.
    // If the jump was refused (a transition already mid-flight), stay up: fading out
    // over whatever page is beneath would strand the player outside their form.
    if (this.cb.onPreview(built.puzzle, title)) this.fadeOut();
  }

  // Pending display:none from a fadeOut — cancelled if show() lands mid-fade.
  private hideTimer: number | null = null;

  /** Reveal the overlay again after a preview — instantly at full opacity (a fade-IN here
   *  would flash whatever page swap is happening behind it). */
  show() {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.root.style.display = '';
    this.root.style.transition = 'none'; // suppress the opacity fade for this reveal
    this.root.classList.add('wf-open');
    void this.root.offsetHeight; // flush styles so the suppression actually applies
    this.root.style.transition = '';
  }

  /** Fade the overlay out (the .2s opacity transition), then take it out of the way. */
  private fadeOut() {
    this.root.classList.remove('wf-open');
    this.hideTimer = window.setTimeout(() => {
      this.root.style.display = 'none';
      this.hideTimer = null;
    }, 220);
  }

  private async publish() {
    const built = this.buildPuzzle();
    if (!built.ok) return this.showError(built.message);
    const title = this.title();
    if (title.length === 0) return this.showError('Give your puzzle a title before publishing.');

    // Instant client-side gate; the server enforces the same list authoritatively.
    if (findBlockedTerm(title, ...built.puzzle.words.map((w) => w.text))) {
      return this.showError('Please remove offensive language before publishing.');
    }

    const btn = this.q<HTMLButtonElement>('.wf-publish');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'PUBLISHING…';
    this.clearError();

    const result = await publishPuzzle(title, built.puzzle);
    if (this.closed) return;
    if (result.ok) {
      btn.textContent = 'PUBLISHED! ✓';
      btn.classList.add('wf-ok');
      // The draft is now a real post — a fresh open should start blank, not resurrect it.
      this.published = true;
      savedDraft = null;
      this.showSuccess('Published! Opening your post…', result.url);
      void navigateToPost(result.url);
    } else {
      btn.disabled = false;
      btn.textContent = original;
      this.showError(result.message);
    }
  }

  // ---------- teardown ----------

  private close() {
    this.teardown();
    this.cb.onClose();
  }

  private teardown() {
    if (this.closed) return;
    this.closed = true;
    if (liveEditor === this) liveEditor = null;
    // Keep an unpublished draft so an accidental back-tap doesn't lose the work; a
    // published one is done and the next open starts fresh.
    savedDraft = this.published
      ? null
      : {
          words: this.words.map((w) => ({ ...w })),
          links: this.links.map((l) => ({ ...l })),
          title: this.titleInput.value,
          idSeq: this.idSeq,
        };
    // If we're torn down while hidden (mid-preview), reveal first so the fade-out is seen.
    this.root.style.display = '';
    this.root.classList.remove('wf-open');
    const node = this.root;
    window.setTimeout(() => node.remove(), 220);
  }

  // ---------- helpers ----------

  private showError(message: string) {
    this.errorEl.classList.remove('wf-success');
    this.errorEl.textContent = message;
    this.errorEl.classList.add('wf-show');
  }

  /** Green confirmation banner; with a URL it carries a tappable "View your post" link as a
   *  fallback in case the automatic navigation is suppressed. */
  private showSuccess(message: string, url?: string) {
    this.errorEl.replaceChildren(document.createTextNode(message));
    if (url) {
      const a = el('a', 'wf-success-link');
      a.textContent = 'View your post →';
      a.href = url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        void navigateToPost(url);
      });
      this.errorEl.append(' ', a);
    }
    this.errorEl.classList.add('wf-show', 'wf-success');
  }

  private clearError() {
    this.errorEl.classList.remove('wf-success');
    this.errorEl.textContent = '';
    this.errorEl.classList.remove('wf-show');
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    const found = this.root.querySelector(sel);
    if (!found) throw new Error(`PuzzleEditor: missing ${sel}`);
    return found as T;
  }

  private shell(): string {
    return `
      <div class="wf-ed-card">
        <div class="wf-ed-head">
          <button class="wf-back" aria-label="Back to menu">←</button>
          <h1 class="wf-ed-title">CREATE A PUZZLE</h1>
        </div>
        <p class="wf-ed-hint">Add words, mark the answer(s) as <b>HIDDEN</b>, then link pairs and pick how they relate.</p>

        <label class="wf-field-label">TITLE</label>
        <input class="wf-input wf-title-input" type="text" maxlength="60" placeholder="Name your puzzle" aria-label="Puzzle title" />

        <div class="wf-section-head"><span class="wf-dot wf-dot-pink"></span>WORDS</div>
        <div class="wf-word-list"></div>
        <button class="wf-add wf-add-word">+ ADD WORD</button>

        <div class="wf-section-head"><span class="wf-dot wf-dot-cyan"></span>LINKS</div>
        <div class="wf-note">A row reads left to right — e.g. WHEEL · part of → CAR.</div>
        <div class="wf-link-list"></div>
        <button class="wf-add wf-add-link">+ ADD LINK</button>

        <div class="wf-ed-error" role="alert"></div>

        <div class="wf-ed-actions">
          <button class="wf-btn wf-ghost wf-preview">▶ PREVIEW</button>
          <button class="wf-btn wf-primary wf-publish">PUBLISH TO REDDIT</button>
        </div>
      </div>
    `;
  }
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Inject the Memphis-styled editor CSS once. Colours come from the shared PALETTE so the
 *  overlay stays in lockstep with the canvas game. */
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const ink = cssColor(PALETTE.ink);
  const offWhite = cssColor(PALETTE.offWhite);
  const pink = cssColor(PALETTE.pink);
  const cyan = cssColor(PALETTE.cyan);
  const yellow = cssColor(PALETTE.yellow);
  const navy = cssColor(PALETTE.navy);
  const shadow = cssColor(PALETTE.ink, 0.9);

  const css = `
    .wf-editor {
      position: fixed; inset: 0; z-index: 1000;
      background: ${offWhite};
      font-family: ${UI_FONT};
      color: ${ink};
      overflow-y: auto; -webkit-overflow-scrolling: touch;
      /* Reserve the scrollbar's lane up front — without this the centred card nudges
         sideways the instant content grows past one screen (rows added / error shown). */
      scrollbar-gutter: stable;
      /* align-items:flex-start (not the default stretch) so the card sizes to its content
         instead of being pinned to viewport height — otherwise a card taller than the screen
         strands its bottom padding mid-scroll and the action buttons end up flush. */
      display: flex; justify-content: center; align-items: flex-start;
      opacity: 0; transition: opacity .2s ease;
    }
    .wf-editor.wf-open { opacity: 1; }
    /* Entrance is a plain fade — a translate here read as the page "shifting" after load. */
    .wf-ed-card {
      width: 100%; max-width: 500px;
      padding: 18px 18px calc(56px + env(safe-area-inset-bottom, 0px)); box-sizing: border-box;
    }

    .wf-ed-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .wf-ed-title { font-size: 26px; font-weight: 900; margin: 0; letter-spacing: 1px; }
    .wf-ed-hint { font-size: 13px; font-weight: 700; color: ${navy}; margin: 0 0 16px; line-height: 1.4; }
    .wf-ed-hint b { color: ${ink}; }

    .wf-field-label, .wf-section-head {
      font-size: 13px; font-weight: 900; letter-spacing: 2px; margin: 14px 0 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .wf-section-head { font-size: 15px; margin-top: 22px; }
    .wf-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid ${ink}; }
    .wf-dot-pink { background: ${pink}; }
    .wf-dot-cyan { background: ${cyan}; }

    .wf-input, .wf-select {
      font-family: ${UI_FONT}; font-weight: 800; color: ${ink};
      background: #fff; border: 3px solid ${ink}; border-radius: 12px;
      padding: 11px 12px; font-size: 15px; box-sizing: border-box;
      box-shadow: 3px 4px 0 ${cssColor(PALETTE.ink, 0.18)};
      outline: none;
    }
    .wf-input { width: 100%; text-transform: uppercase; letter-spacing: 1px; }
    .wf-input::placeholder { color: #b8b4a8; font-weight: 700; letter-spacing: 0; }
    .wf-input:focus, .wf-select:focus { box-shadow: 3px 4px 0 ${cyan}; }

    .wf-title-input { text-transform: none; letter-spacing: 0; }

    .wf-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .wf-word .wf-input { flex: 1 1 auto; min-width: 0; }

    .wf-seg { display: flex; border: 3px solid ${ink}; border-radius: 12px; overflow: hidden; flex: 0 0 auto; box-shadow: 3px 4px 0 ${cssColor(PALETTE.ink, 0.18)}; }
    .wf-seg-btn {
      font-family: ${UI_FONT}; font-weight: 900; font-size: 11px; letter-spacing: 1px;
      border: none; background: #fff; color: ${ink}; padding: 10px 10px; cursor: pointer;
    }
    .wf-seg-btn + .wf-seg-btn { border-left: 3px solid ${ink}; }
    .wf-seg-btn.wf-on { background: ${yellow}; }
    .wf-seg-btn:nth-child(2).wf-on { background: ${pink}; color: #fff; }

    /* One row reads as a sentence: WORD · relation → WORD. The relation select takes the
       largest share (its labels are the longest); the two word selects flank it. Labels are
       kept terse (no "means " prefix) so nothing clips on the single row. */
    .wf-link .wf-select { flex: 1 1 0; min-width: 0; }
    .wf-link .wf-type { flex: 2 1 0; }

    .wf-del {
      flex: 0 0 auto; width: 36px; height: 36px; border-radius: 10px;
      border: 3px solid ${ink}; background: #fff; color: ${ink};
      font-size: 20px; font-weight: 900; line-height: 1; cursor: pointer;
      box-shadow: 3px 4px 0 ${cssColor(PALETTE.ink, 0.18)};
    }
    .wf-del:active { transform: translate(2px, 3px); box-shadow: none; }

    .wf-add {
      font-family: ${UI_FONT}; font-weight: 900; font-size: 13px; letter-spacing: 1px;
      background: #fff; color: ${ink}; border: 3px dashed ${ink}; border-radius: 12px;
      padding: 11px; width: 100%; cursor: pointer; margin-top: 2px;
    }
    .wf-add:active { transform: translate(1px, 2px); }
    .wf-add:disabled { opacity: .55; cursor: default; }
    .wf-add:disabled:active { transform: none; }

    .wf-empty { font-size: 12px; font-weight: 700; color: #8a8577; padding: 4px 2px 10px; }
    .wf-note { font-size: 12px; font-weight: 700; color: #8a8577; margin: -2px 0 10px; }

    .wf-arrow { flex: 0 0 auto; font-weight: 900; font-size: 16px; color: ${ink}; }

    .wf-ed-error {
      min-height: 0; overflow: hidden; margin-top: 16px;
      font-size: 13px; font-weight: 800; color: #fff;
      background: ${pink}; border: 3px solid ${ink}; border-radius: 12px;
      padding: 0 12px; max-height: 0; opacity: 0;
      transition: max-height .18s ease, opacity .18s ease, padding .18s ease;
      box-shadow: 4px 5px 0 ${cssColor(PALETTE.ink, 0.2)};
    }
    .wf-ed-error.wf-show { max-height: 120px; opacity: 1; padding: 11px 12px; }
    .wf-ed-error.wf-success { background: ${cssColor(PALETTE.green)}; }
    .wf-success-link { color: #fff; font-weight: 900; text-decoration: underline; }

    .wf-ed-actions { display: flex; gap: 10px; margin-top: 22px; }
    .wf-btn {
      font-family: ${UI_FONT}; font-weight: 900; font-size: 15px; letter-spacing: 1px;
      border: 4px solid ${ink}; border-radius: 14px; padding: 14px 10px; cursor: pointer;
      box-shadow: 5px 6px 0 ${shadow};
      transition: transform .05s ease, box-shadow .05s ease;
    }
    .wf-btn:active { transform: translate(3px, 4px); box-shadow: 1px 1px 0 ${shadow}; }
    .wf-ghost { flex: 1 1 0; background: #fff; color: ${ink}; }
    .wf-primary { flex: 1.4 1 0; background: ${cyan}; color: ${ink}; }
    .wf-btn.wf-ok { background: ${cssColor(PALETTE.green)}; color: #fff; }
    .wf-btn:disabled { opacity: .7; cursor: default; }

    .wf-back {
      flex: 0 0 auto; width: 42px; height: 42px; border-radius: 12px;
      border: 3px solid ${ink}; background: ${yellow}; color: ${ink};
      font-size: 22px; font-weight: 900; cursor: pointer; line-height: 1;
      box-shadow: 3px 4px 0 ${cssColor(PALETTE.ink, 0.2)};
    }
    .wf-back:active { transform: translate(2px, 3px); box-shadow: none; }
  `;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
