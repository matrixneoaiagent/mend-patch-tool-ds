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

type Edit = ((tree: Tree) => void) & { move?: { from: string; to: string } };

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

/* ---------- Section 5: matching lines ---------- */

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function normalizeLine(s: string, tier: number): string {
  let t = s;
  if (tier >= 1) t = t.replace(/[ \t]+$/, '');
  if (tier >= 2) t = t.replace(/^[ \t]+/, '');
  return t;
}

function matchesAt(oldLines: string[], fileLines: string[], at: number, tier: number): boolean {
  for (let j = 0; j < oldLines.length; j += 1) {
    if (normalizeLine(oldLines[j]!, tier) !== normalizeLine(fileLines[at + j]!, tier)) return false;
  }
  return true;
}

function occurrencesAt(oldLines: string[], fileLines: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
    if (matchesAt(oldLines, fileLines, i, tier)) out.push(i);
  }
  return out;
}

function findTier(oldLines: string[], fileLines: string[], strict: boolean): { tier: number; occurrences: number[] } | null {
  for (const tier of tiers(strict)) {
    const occurrences = occurrencesAt(oldLines, fileLines, tier);
    if (occurrences.length > 0) return { tier, occurrences };
  }
  return null;
}

function leadingIndent(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function reindentLine(line: string, tier: number, oldIndent: string, fileIndent: string): string {
  if (tier !== 2) return line;
  if (line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(oldIndent)) {
    return fileIndent + line.slice(oldIndent.length);
  }
  return line;
}

interface Doc {
  lines: string[];
  final: boolean;
  br: string;
}

function readDoc(text: string | null): Doc {
  if (text === null || text === '') return { lines: [], final: false, br: '\n' };
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  let body = text;
  let final = false;
  if (body.endsWith('\n')) {
    final = true;
    body = body.slice(0, -1);
  }
  if (br === '\r\n' && body.endsWith('\r')) body = body.slice(0, -1);
  const lines = body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, final, br };
}

function joinDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

type HunkKind = 'ctx' | 'old' | 'new' | 'eol';

interface HunkLine {
  kind: HunkKind;
  text: string;
}

interface Hunk {
  A: number;
  C: number;
  body: HunkLine[];
}

function hunkOldLines(body: HunkLine[]): HunkLine[] {
  return body.filter((l) => l.kind === 'ctx' || l.kind === 'old');
}

function hunkNewLines(body: HunkLine[]): HunkLine[] {
  return body.filter((l) => l.kind === 'ctx' || l.kind === 'new');
}

function buildReplacement(body: HunkLine[], fileLines: string[], at: number, tier: number): string[] {
  const oldEntries = hunkOldLines(body);
  const oldIndent = leadingIndent(oldEntries.length > 0 ? oldEntries[0]!.text : '');
  const fileIndent = leadingIndent(fileLines[at] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const entry of body) {
    if (entry.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (entry.kind === 'old') {
      oi += 1;
    } else if (entry.kind === 'new') {
      out.push(reindentLine(entry.text, tier, oldIndent, fileIndent));
    }
  }
  return out;
}

function eolAfterLastContextOrNew(body: HunkLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const kind = body[i]!.kind;
    if (kind === 'ctx' || kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1]?.kind === 'eol';
}

/* ---------- Section 6: unified diffs ---------- */

function parseHunkHeader(line: string): Hunk | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return { A: Number(m[1]), C: Number(m[2]), body: [] };
}

function parseHunkBody(lines: string[], start: number): { body: HunkLine[]; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('diff --git ')) break;
    if (line === '') {
      raw.push(line);
      i += 1;
      continue;
    }
    const c = line.charAt(0);
    if (c !== ' ' && c !== '-' && c !== '+' && c !== '\\') break;
    raw.push(line);
    i += 1;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: HunkLine[] = raw.map((line) => {
    if (line === '') return { kind: 'ctx', text: '' };
    const c = line.charAt(0);
    if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
    if (c === '-') return { kind: 'old', text: line.slice(1) };
    if (c === '+') return { kind: 'new', text: line.slice(1) };
    return { kind: 'eol', text: line.slice(1) };
  });
  return { body, next: i };
}

function patchPathAfter(line: string, n: number): string {
  let p = line.slice(n);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

function stripPathPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function applyUnifiedHunk(doc: Doc, hunk: Hunk, offset: number, strict: boolean, path: string): void {
  const oldEntries = hunkOldLines(hunk.body);
  const oldLines = oldEntries.map((l) => l.text);
  if (oldLines.length === 0) {
    const length = doc.lines.length;
    const at = Math.min(Math.max(hunk.A + offset, 0), length);
    const add = hunkNewLines(hunk.body).filter((l) => l.kind === 'new').map((l) => l.text);
    doc.lines.splice(at, 0, ...add);
    if (at === length) doc.final = !eolAfterLastContextOrNew(hunk.body);
    return;
  }
  const found = findTier(oldLines, doc.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.A - 1 + offset;
  let start = found.occurrences[0]!;
  let distance = Math.abs(start - target);
  for (const at of found.occurrences) {
    const d = Math.abs(at - target);
    if (d < distance) {
      distance = d;
      start = at;
    }
  }
  const replacement = buildReplacement(hunk.body, doc.lines, start, found.tier);
  const end = start + oldLines.length;
  const length = doc.lines.length;
  doc.lines.splice(start, oldLines.length, ...replacement);
  if (end === length) doc.final = !eolAfterLastContextOrNew(hunk.body);
}

function applyUnifiedHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let offset = 0;
  for (const hunk of hunks) {
    const oldCount = hunkOldLines(hunk.body).length;
    const newCount = hunkNewLines(hunk.body).length;
    applyUnifiedHunk(doc, hunk, offset, strict, path);
    offset += newCount - oldCount;
  }
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  renameFromSeen: boolean;
  renameToSeen: boolean;
  createFlag: boolean;
  deleteFlag: boolean;
  headerComplete: boolean;
  hunks: Hunk[];
}

function buildUnifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairSeen ? sec.pairOld : sec.renameFromSeen ? sec.renameFrom : sec.diffOld;
  const newPath = sec.pairSeen ? sec.pairNew : sec.renameToSeen ? sec.renameTo : sec.diffNew;
  const oldGone = oldPath === '/dev/null';
  const newGone = newPath === '/dev/null';
  const creation = oldGone || sec.createFlag;
  const deletion = !creation && (newGone || sec.deleteFlag);
  const from = oldGone ? null : oldPath;
  const to = newGone ? null : newPath;

  if (creation) {
    const p = to ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let final = true;
      for (const hunk of sec.hunks) {
        const body = hunk.body;
        for (let i = 0; i < body.length; i += 1) {
          const entry = body[i]!;
          if (entry.kind === 'new') {
            lines.push(entry.text);
            final = body[i + 1]?.kind !== 'eol';
          }
        }
      }
      tree.now.set(p, joinDoc({ lines, final, br: '\n' }));
    };
  }

  if (deletion) {
    const p = from ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }

  if (from !== null && to !== null && from !== to) {
    const moveFrom = from;
    const moveTo = to;
    const edit: Edit = (tree) => {
      if (!safe(moveFrom)) throw new Fail('unsafe', moveFrom);
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(moveFrom);
      if (before === null) throw new Fail('missing', moveFrom);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const doc = readDoc(before);
      applyUnifiedHunks(doc, sec.hunks, strict, moveFrom);
      tree.now.set(moveTo, joinDoc(doc));
      tree.now.set(moveFrom, null);
    };
    edit.move = { from: moveFrom, to: moveTo };
    return edit;
  }

  const p = from ?? to ?? '';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = readDoc(before);
    applyUnifiedHunks(doc, sec.hunks, strict, p);
    tree.now.set(p, joinDoc(doc));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const fresh = (): USection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    pairSeen: false,
    renameFrom: null,
    renameTo: null,
    renameFromSeen: false,
    renameToSeen: false,
    createFlag: false,
    deleteFlag: false,
    headerComplete: false,
    hunks: [],
  });
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh();
      sec.diffOld = stripPathPrefix(m[1]!);
      sec.diffNew = stripPathPrefix(m[2]!);
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ') && (sec === null || sec.headerComplete)) {
      sec = fresh();
      sections.push(sec);
    }
    if (sec === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!sec.headerComplete) {
      if (line.startsWith('@@')) {
        const hunk = parseHunkHeader(line);
        if (hunk === null) throw new Exit2(`error: parse ${i + 1}`);
        const parsed = parseHunkBody(lines, i + 1);
        hunk.body = parsed.body;
        sec.hunks.push(hunk);
        sec.headerComplete = true;
        i = parsed.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (next.startsWith('+++ ')) {
          sec.pairOld = stripPathPrefix(patchPathAfter(line, 4));
          sec.pairNew = stripPathPrefix(patchPathAfter(next, 4));
          sec.pairSeen = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = stripPathPrefix(line.slice('rename from '.length).trim());
        sec.renameFromSeen = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = stripPathPrefix(line.slice('rename to '.length).trim());
        sec.renameToSeen = true;
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.createFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deleteFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line);
      if (hunk === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      hunk.body = parsed.body;
      sec.hunks.push(hunk);
      i = parsed.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => buildUnifiedSectionEdit(s, strict));
}

/* ---------- Section 7: SEARCH/REPLACE blocks ---------- */

interface SRBlock {
  oldLines: string[];
  newLines: string[];
  path: string;
}

function buildSearchReplaceEdit(block: SRBlock, strict: boolean): Edit {
  const { oldLines, newLines, path } = block;
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinDoc({ lines: newLines.slice(), final: true, br: '\n' }));
    };
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = readDoc(before);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occurrences.length !== 1) throw new Fail('ambiguous', path);
    const at = found.occurrences[0]!;
    const oldIndent = leadingIndent(oldLines[0]!);
    const fileIndent = leadingIndent(doc.lines[at]!);
    const replacement = newLines.map((l) => reindentLine(l, found.tier, oldIndent, fileIndent));
    doc.lines.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, joinDoc(doc));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let previousEnd = 0;
  let previousPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let sep = i + 1;
    while (sep < lines.length && lines[sep]!.trimEnd() !== '=======') sep += 1;
    if (sep >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let end = sep + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let p = i - 1; p >= previousEnd; p -= 1) {
      const candidate = lines[p]!;
      if (blank(candidate)) continue;
      const trimmed = candidate.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = previousPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end), path });
    previousEnd = end + 1;
    previousPath = path;
    i = end + 1;
  }
  return blocks.map((b) => buildSearchReplaceEdit(b, strict));
}

/* ---------- Section 8: V4A patches ---------- */

interface V4Chunk {
  anchor: string | null;
  body: HunkLine[];
  endOfFile: boolean;
}

function findSingleLine(needle: string, fileLines: string[], from: number, strict: boolean): { index: number; tier: number } | null {
  for (const tier of tiers(strict)) {
    const n = normalizeLine(needle, tier);
    for (let i = from; i < fileLines.length; i += 1) {
      if (normalizeLine(fileLines[i]!, tier) === n) return { index: i, tier };
    }
  }
  return null;
}

function findChunkOccurrence(oldLines: string[], fileLines: string[], from: number, strict: boolean, endOfFile: boolean): { start: number; tier: number } | null {
  for (const tier of tiers(strict)) {
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      if (endOfFile && i + oldLines.length !== fileLines.length) continue;
      if (matchesAt(oldLines, fileLines, i, tier)) return { start: i, tier };
    }
  }
  return null;
}

function applyV4Chunks(doc: Doc, chunks: V4Chunk[], strict: boolean, path: string): void {
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const anchor = findSingleLine(chunk.anchor, doc.lines, cursor, strict);
      if (anchor === null) throw new Fail('no-match', path);
      cursor = anchor.index + 1;
    }
    const oldEntries = hunkOldLines(chunk.body);
    const oldLines = oldEntries.map((l) => l.text);
    const newEntries = hunkNewLines(chunk.body);
    if (oldLines.length === 0) {
      const at = chunk.endOfFile ? doc.lines.length : cursor;
      const add = newEntries.filter((l) => l.kind === 'new').map((l) => l.text);
      doc.lines.splice(at, 0, ...add);
      cursor = at + add.length;
      continue;
    }
    const found = findChunkOccurrence(oldLines, doc.lines, cursor, strict, chunk.endOfFile);
    if (found === null) throw new Fail('no-match', path);
    const replacement = buildReplacement(chunk.body, doc.lines, found.start, found.tier);
    doc.lines.splice(found.start, oldLines.length, ...replacement);
    cursor = found.start + newEntries.length;
  }
}

function buildAddFileEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinDoc({ lines: fileLines, final: true, br: '\n' }));
  };
}

function buildDeleteFileEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function buildUpdateFileEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean): Edit {
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const doc = readDoc(before);
    applyV4Chunks(doc, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, joinDoc(doc));
      tree.now.set(path, null);
    } else {
      tree.now.set(path, joinDoc(doc));
    }
  };
  if (moveTo !== null) edit.move = { from: path, to: moveTo };
  return edit;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  let first = 0;
  while (first < lines.length && blank(lines[first]!)) first += 1;
  if (first >= lines.length) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isStart = (s: string): boolean =>
    s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last && !isStart(lines[j]!)) {
        collected.push(lines[j]!);
        j += 1;
      }
      while (collected.length > 0 && blank(collected[collected.length - 1]!)) collected.pop();
      const fileLines: string[] = [];
      for (let idx = 0; idx < collected.length; idx += 1) {
        const content = collected[idx]!;
        if (content === '') fileLines.push('');
        else if (content.startsWith('+')) fileLines.push(content.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + idx}`);
      }
      edits.push(buildAddFileEdit(path, fileLines));
      i = j;
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last && !isStart(lines[j]!)) {
        collected.push(lines[j]!);
        j += 1;
      }
      while (collected.length > 0 && blank(collected[collected.length - 1]!)) collected.pop();
      if (collected.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(buildDeleteFileEdit(path));
      i = j;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last && !isStart(lines[j]!)) {
        collected.push(lines[j]!);
        j += 1;
      }
      while (collected.length > 0 && blank(collected[collected.length - 1]!)) collected.pop();

      let moveTo: string | null = null;
      let k = 0;
      if (collected.length > 0 && collected[0]!.startsWith('*** Move to: ')) {
        moveTo = collected[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }

      const chunks: V4Chunk[] = [];
      let firstChunk = true;
      while (k < collected.length) {
        let anchor: string | null = null;
        const head = collected[k]!;
        if (head.startsWith('@@')) {
          const text = head.slice(2).trim();
          anchor = text === '' ? null : text;
          k += 1;
        } else if (!firstChunk) {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        } else {
          const c0 = head.charAt(0);
          if (head !== '' && c0 !== ' ' && c0 !== '-' && c0 !== '+') throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        firstChunk = false;
        const body: HunkLine[] = [];
        let endOfFile = false;
        while (k < collected.length) {
          const bl = collected[k]!;
          if (bl.startsWith('@@')) break;
          if (bl.trimEnd() === '*** End of File') {
            endOfFile = true;
            k += 1;
            break;
          }
          if (bl === '') {
            body.push({ kind: 'ctx', text: '' });
            k += 1;
            continue;
          }
          const c = bl.charAt(0);
          if (c === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
          else if (c === '-') body.push({ kind: 'old', text: bl.slice(1) });
          else if (c === '+') body.push({ kind: 'new', text: bl.slice(1) });
          else throw new Exit2(`error: parse ${i + 2 + k}`);
          k += 1;
        }
        chunks.push({ anchor, body, endOfFile });
      }

      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(buildUpdateFileEdit(path, moveTo, chunks, strict));
      i = j;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) if (edit.move !== undefined) moves.push(edit.move);
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of moves) {
    movedFrom.add(m.from);
    movedTo.add(m.to);
  }
  interface Row {
    key: string;
    text: string;
    apply: () => void;
  }
  const rows: Row[] = [];
  for (const m of moves) {
    const target = tree.now.get(m.to);
    rows.push({
      key: m.to,
      text: `R ${m.from} -> ${m.to}`,
      apply: () => {
        if (target !== null && target !== undefined) {
          mkdirSync(dirname(m.to), { recursive: true });
          writeFileSync(m.to, target);
        }
        rmSync(m.from, { force: true });
      },
    });
  }
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({
      key: p,
      text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      apply: () => {
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      },
    });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) for (const row of rows) row.apply();
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
