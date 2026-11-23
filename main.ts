// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5) and the unified-diff reader (section 6).
//
// How I think about it: a file is kept as its lines plus the break it used
// and whether it ended with one, so a rewrite can put the same shape back.
// A match is tried at three looseness levels and the first level with any
// hit wins; a hit is a start index where every old line lines up. When a
// hunk replaces lines, the lines shared by old and new always come from the
// file itself, and at the loosest level the other new lines are shifted from
// the patch's indent to the file's indent. A unified section is one edit:
// its header names the paths, its hunks apply in order to the result of the
// ones before, each hunk picking the hit nearest the line number it claims.
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file broken into lines, remembering its break style and final break. */
interface FileView {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileView {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function joinFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.finalBr ? v.br : '');
}

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occurrencesAt(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  if (old.length === 0 || old.length > lines.length) return found;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!tierEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier with a hit at or after `from`, and every hit position there. */
function locate(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (const t of tiersToTry(strict)) {
    const at = occurrencesAt(lines, old, t).filter((p) => p >= from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One body line of a hunk or a chunk: shared by old and new, removed, added. */
type BodyItem = { kind: 'ctx' | 'del' | 'add'; text: string };

/** Split a body into old lines and new lines; remember, for each shared new line, which old line it is. */
function splitBody(items: BodyItem[]): { oldLines: string[]; newLines: string[]; ctxOld: Map<number, number> } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctxOld = new Map<number, number>();
  for (const it of items) {
    if (it.kind === 'ctx') {
      ctxOld.set(newLines.length, oldLines.length);
      oldLines.push(it.text);
      newLines.push(it.text);
    } else if (it.kind === 'del') {
      oldLines.push(it.text);
    } else {
      newLines.push(it.text);
    }
  }
  return { oldLines, newLines, ctxOld };
}

/** Build the lines that replace a match: shared lines come from the file, other lines re-indent at tier 2. */
function renderNew(newLines: string[], ctxOld: Map<number, number>, fileLines: string[], pos: number, tier: number, oldFirst: string): string[] {
  const out: string[] = [];
  const fLead = leadWs(fileLines[pos] ?? '');
  const pLead = leadWs(oldFirst);
  for (let j = 0; j < newLines.length; j++) {
    const oi = ctxOld.get(j);
    if (oi !== undefined) {
      out.push(fileLines[pos + oi]!);
      continue;
    }
    const line = newLines[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(pLead)) out.push(fLead + line.slice(pLead.length));
    else out.push(line);
  }
  return out;
}

/** Moves that succeeded, in patch order, so the exit-0 report can print R lines. */
const movePairs: Array<[string, string]> = [];

/** One hunk of a unified diff. */
interface Hunk {
  a: number;
  items: BodyItem[];
  /** a `\` line follows this hunk's last shared-or-added line */
  noBreakAtEnd: boolean;
  /** a `\` line follows this hunk's last added line */
  noBreakAfterLastAdd: boolean;
}

/** One section of a unified diff: the paths it names and its hunks. */
interface UnifiedSection {
  start: number;
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Read one hunk body starting at `j`; empty lines at its end are not part of it. */
function readHunkBody(lines: string[], j: number): { items: BodyItem[]; noBreakAtEnd: boolean; noBreakAfterLastAdd: boolean; next: number } {
  const raw: Array<BodyItem | 'slash'> = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      raw.push({ kind: 'ctx', text: '' });
      k++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      raw.push({ kind: 'ctx', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '-') {
      raw.push({ kind: 'del', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '+') {
      raw.push({ kind: 'add', text: l.slice(1) });
      k++;
      continue;
    }
    if (c === '\\') {
      raw.push('slash');
      k++;
      continue;
    }
    break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last !== 'slash' && last.kind === 'ctx' && last.text === '') raw.pop();
    else break;
  }
  const items: BodyItem[] = raw.filter((r): r is BodyItem => r !== 'slash');
  let lastCtxAdd = -1;
  let lastAdd = -1;
  raw.forEach((r, idx) => {
    if (r === 'slash') return;
    if (r.kind === 'ctx' || r.kind === 'add') lastCtxAdd = idx;
    if (r.kind === 'add') lastAdd = idx;
  });
  return {
    items,
    noBreakAtEnd: lastCtxAdd >= 0 && raw[lastCtxAdd + 1] === 'slash',
    noBreakAfterLastAdd: lastAdd >= 0 && raw[lastAdd + 1] === 'slash',
    next: k,
  };
}

function readHunk(lines: string[], j: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[j]!);
  if (m === null) throw new Exit2(`error: parse ${j + 1}`);
  const body = readHunkBody(lines, j + 1);
  return { hunk: { a: Number(m[1]), items: body.items, noBreakAtEnd: body.noBreakAtEnd, noBreakAfterLastAdd: body.noBreakAfterLastAdd }, next: body.next };
}

/** A `--- <path>` / `+++ <path>` header line: text after the four characters, up to the first tab, trimmed, with one leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Read one unified section starting at line `s`; return it and the line after it. */
function parseUnifiedSection(lines: string[], s: number): { section: UnifiedSection; next: number } {
  let j = s;
  let gitOld: string | undefined;
  let gitNew: string | undefined;
  if (lines[j]!.startsWith('diff --git ')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[j]!);
    if (m === null) throw new Exit2(`error: parse ${j + 1}`);
    gitOld = m[1];
    gitNew = m[2];
    j++;
  }
  let pairOld: string | undefined;
  let pairNew: string | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let create = false;
  let remove = false;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      const nxt = lines[j + 1];
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
      if (pairOld !== undefined) break;
      pairOld = headerPath(l);
      pairNew = headerPath(nxt);
      j += 2;
      continue;
    }
    if (l.startsWith('+++ ')) {
      if (pairNew === undefined) pairNew = headerPath(l);
      j++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renameOld = l.slice('rename from '.length).trim();
      j++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameNew = l.slice('rename to '.length).trim();
      j++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      create = true;
      j++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      remove = true;
      j++;
      continue;
    }
    j++;
  }
  const isDelete = remove || pairNew === '/dev/null';
  const isCreate = create || pairOld === '/dev/null';
  const hunks: Hunk[] = [];
  if (!isDelete) {
    while (j < lines.length && lines[j]!.startsWith('@@')) {
      const r = readHunk(lines, j);
      hunks.push(r.hunk);
      j = r.next;
    }
  } else {
    // A deletion's hunks are not read: skip to the next section start.
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      j++;
    }
  }
  let oldP: string | null | undefined = pairOld ?? renameOld ?? gitOld;
  let newP: string | null | undefined = pairNew ?? renameNew ?? gitNew;
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  if (oldP === undefined || newP === undefined || (oldP === null && newP === null)) throw new Exit2(`error: parse ${s + 1}`);
  return { section: { start: s, oldPath: oldP, newPath: newP, create: isCreate, remove: isDelete, hunks }, next: j };
}

/** Apply a section's hunks in order to a file view; d tracks how much earlier hunks shifted the lines. */
function applyHunks(view: FileView, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines, ctxOld } = splitBody(h.items);
    if (oldLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), view.lines.length);
      view.lines.splice(at, 0, ...newLines);
      d += newLines.length;
      if (newLines.length > 0 && at === view.lines.length - newLines.length) view.finalBr = !h.noBreakAtEnd;
      continue;
    }
    const found = locate(view.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + oldLines.length === view.lines.length;
    const repl = renderNew(newLines, ctxOld, view.lines, best, found.tier, oldLines[0]!);
    view.lines.splice(best, oldLines.length, ...repl);
    d += newLines.length - oldLines.length;
    if (atEnd) view.finalBr = !h.noBreakAtEnd;
  }
}

/** Turn one parsed unified section into the edit it performs. */
function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const added: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') added.push(it.text);
      let lastAddSlash = false;
      let seenAdd = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.items.some((it) => it.kind === 'add')) {
          lastAddSlash = h.noBreakAfterLastAdd;
          seenAdd = true;
          break;
        }
      }
      tree.now.set(np, added.length === 0 ? '' : added.join('\n') + (seenAdd && !lastAddSlash ? '\n' : ''));
      return;
    }
    if (sec.remove || newP === null) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const view = splitFile(tree.get(oldP!)!);
      applyHunks(view, sec.hunks, strict, oldP!);
      tree.now.set(newP!, joinFile(view));
      tree.now.set(oldP!, null);
      movePairs.push([oldP!, newP!]);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const view = splitFile(cur);
    applyHunks(view, sec.hunks, strict, p);
    tree.now.set(p, joinFile(view));
  };
}

/** Read a whole patch as unified diffs: sections, prose ignored between them. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const r = parseUnifiedSection(lines, i);
      edits.push(unifiedEdit(r.section, strict));
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const r = parseUnifiedSection(lines, i);
        edits.push(unifiedEdit(r.section, strict));
        i = r.next;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7) and V4A patches (section 8).
//
// A SEARCH/REPLACE block carries its path on the nearest useful line above
// it, and each block must match exactly once: several hits is ambiguous,
// none is no-match, and there is no nearest-hit rule here. A V4A patch is a
// fenced list of file sections; an Update section walks its chunks with a
// cursor that only moves forward, so a later chunk can never rewrite what
// an earlier one already passed, and an anchor jump moves the cursor past
// the anchor line first. An end-of-file chunk only counts when its match
// runs to the file's last line.
// ---------------------------------------------------------------------------

/** Turn one SEARCH/REPLACE block into the edit it performs. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const view = splitFile(cur);
    const found = locate(view.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const repl = renderNew(newLines, new Map(), view.lines, pos, found.tier, oldLines[0]!);
    view.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(view));
  };
}

/** Read a whole patch as SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** One chunk of a V4A Update section: an optional anchor, its body, and whether it is tied to the file's end. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** First line at or after `from` equal to a single-line anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const t of tiersToTry(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

/** Turn one V4A Add section into the edit it performs. */
function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

/** Turn one V4A Delete section into the edit it performs. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Turn one V4A Update section into the edit it performs. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const view = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(view.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines, ctxOld } = splitBody(ch.items);
      if (oldLines.length === 0) {
        const at = ch.eof ? view.lines.length : cursor;
        view.lines.splice(at, 0, ...newLines);
        cursor = at + newLines.length;
        continue;
      }
      if (ch.eof) {
        // Only a match ending at the file's last line counts for an end-of-file chunk.
        const pos = view.lines.length - oldLines.length;
        if (pos < cursor) throw new Fail('no-match', path);
        let tier = -1;
        for (const t of tiersToTry(strict)) {
          let ok = true;
          for (let j = 0; j < oldLines.length; j++) {
            if (!tierEq(view.lines[pos + j]!, oldLines[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const repl = renderNew(newLines, ctxOld, view.lines, pos, tier, oldLines[0]!);
        view.lines.splice(pos, oldLines.length, ...repl);
        cursor = pos + repl.length;
        continue;
      }
      const found = locate(view.lines, oldLines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.at[0]!;
      const repl = renderNew(newLines, ctxOld, view.lines, pos, found.tier, oldLines[0]!);
      view.lines.splice(pos, oldLines.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = joinFile(view);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      movePairs.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Drop the empty shared lines at the end of a chunk body; they are not part of it. */
function trimChunkTail(items: BodyItem[]): BodyItem[] {
  const out = [...items];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') out.pop();
    else break;
  }
  return out;
}

/** Read a whole patch as a V4A patch. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      let pendingBlank = 0;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        if (blank(s)) {
          pendingBlank++;
          i++;
          continue;
        }
        if (s.startsWith('+')) {
          for (let b = 0; b < pendingBlank; b++) raw.push('');
          pendingBlank = 0;
          raw.push(s.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aAddEdit(path, raw));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(path));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let closed = false;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        if (s.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (s.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur.items = trimChunkTail(cur.items);
          chunks.push(cur);
          cur = null;
          closed = true;
          i++;
          continue;
        }
        if (s.startsWith('@@')) {
          if (cur !== null) {
            cur.items = trimChunkTail(cur.items);
            chunks.push(cur);
          }
          const anchor = s.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          closed = false;
          i++;
          continue;
        }
        if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (cur === null) {
            if (s === '') {
              // A blank line with no open chunk is a separator, not a body line.
              i++;
              continue;
            }
            if (closed) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, items: [] };
            closed = false;
          }
          if (s === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (s.startsWith(' ')) cur.items.push({ kind: 'ctx', text: s.slice(1) });
          else if (s.startsWith('-')) cur.items.push({ kind: 'del', text: s.slice(1) });
          else cur.items.push({ kind: 'add', text: s.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        cur.items = trimChunkTail(cur.items);
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded folds its D and A lines into one R line, sorted by the new path; the other
  // changed paths list as before, all in byte order of the path each line sorts by.
  const rows: Array<{ key: string; text: string }> = [];
  const folded = new Set<string>();
  for (const [oldP, newP] of movePairs) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      folded.add(oldP);
      folded.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (folded.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
