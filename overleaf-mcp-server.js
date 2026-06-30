#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir, appendFile, access } from 'fs/promises';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const exec       = promisify(execCallback);

const SECTION_LEVELS = {
  section:       1,
  subsection:    2,
  subsubsection: 3,
  paragraph:     4,
};

// ── Load project config ──────────────────────────────────────────────────────
let projectsConfig;
try {
  const configData = await readFile(path.join(__dirname, 'projects.json'), 'utf-8');
  projectsConfig   = JSON.parse(configData);
} catch (error) {
  console.error('Error loading projects.json:', error.message);
  process.exit(1);
}

// ── OverleafGitClient ────────────────────────────────────────────────────────
class OverleafGitClient {
  constructor(projectId, gitToken) {
    this.projectId      = projectId;
    this.gitToken       = gitToken;
    this.repoPath       = path.join(os.tmpdir(), `overleaf-${projectId}`);
    this.gitUrlWithAuth = `https://git:${gitToken}@git.overleaf.com/${projectId}`;
  }

  // ── Git sync ───────────────────────────────────────────────────────────────

  async cloneOrPull() {
    try {
      await exec(`test -d "${this.repoPath}/.git"`);
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git pull "${this.gitUrlWithAuth}"`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch {
      const { stdout } = await exec(
        `git clone "${this.gitUrlWithAuth}" "${this.repoPath}"`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    }
  }

  async commitAndPush(filePath, commitMessage) {
    // git add + commit — tolerate "nothing to commit" (exit 1) which happens
    // when file content is identical to the last commit (e.g. re-create or
    // create_file called twice). The file is already on disk; we still push.
    try {
      await exec(
        `cd "${this.repoPath}" && git add "${filePath}" && git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
    } catch (err) {
      // git commit exits 1 with "nothing to commit" — not a real error
      const msg = (err.stdout || '') + (err.stderr || '');
      if (!msg.includes('nothing to commit') && !msg.includes('nothing added to commit')) {
        throw err;
      }
      // Nothing new to commit — file already matches repo. Continue to push.
    }
    // Pull with rebase before pushing to handle remote changes made directly in Overleaf
    await exec(
      `cd "${this.repoPath}" && git pull --rebase "${this.gitUrlWithAuth}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    await exec(
      `cd "${this.repoPath}" && git push "${this.gitUrlWithAuth}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
  }

  // ── Low-level file I/O ─────────────────────────────────────────────────────

  async readRaw(filePath) {
    await this.cloneOrPull();
    return readFile(path.join(this.repoPath, filePath), 'utf-8');
  }

  async writeRaw(filePath, content, commitMessage) {
    const fullPath = path.join(this.repoPath, filePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    await this.commitAndPush(filePath, commitMessage);
    return `"${filePath}" written and pushed.`;
  }

  // ── Preamble helpers ───────────────────────────────────────────────────────

  /**
   * Return the character index of \begin{document}.
   * Throws if not found — signals this is not a root file.
   */
  _beginDocIndex(content) {
    const match = content.match(/\\begin\{document\}/);
    if (!match) throw new Error('\\begin{document} not found — is this a root .tex file?');
    return match.index;
  }

  async getPreamble(filePath) {
    const content = await this.readRaw(filePath);
    return content.substring(0, this._beginDocIndex(content));
  }

  /**
   * Replace everything before \begin{document} with newPreamble.
   * \begin{document} and everything after it is preserved exactly.
   * newPreamble must NOT include \begin{document}.
   */
  async writePreamble(filePath, newPreamble, commitMessage) {
    const content  = await this.readRaw(filePath);
    const idx      = this._beginDocIndex(content);
    const block    = newPreamble.endsWith('\n') ? newPreamble : newPreamble + '\n';
    const updated  = block + content.substring(idx);
    return this.writeRaw(filePath, updated, commitMessage || 'Update preamble via MCP');
  }

  // ── Heading helpers ────────────────────────────────────────────────────────

  _parseHeadings(content) {
    const headings = [];
    const regex    = /\\(section|subsection|subsubsection|paragraph)\*?\{([^}]+)\}/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const startLine = content.substring(0, m.index).split('\n').length;
      headings.push({
        title: m[2],
        type:  m[1],
        level: SECTION_LEVELS[m[1]],
        index: m.index,
        startLine,
      });
    }
    // Annotate endLine = line before next same-or-higher heading (or end of file)
    const totalLines = content.split('\n').length;
    for (let i = 0; i < headings.length; i++) {
      const next = headings.slice(i + 1).find(h => h.level <= headings[i].level);
      headings[i].endLine = next ? next.startLine - 1 : totalLines;
    }
    return headings;
  }

  _headingBounds(content, title, type = null) {
    const all    = this._parseHeadings(content);
    const target = all.find(h => h.title === title && (!type || h.type === type));
    if (!target) {
      const hint = type ? ` (type: ${type})` : '';
      throw new Error(`Heading "${title}"${hint} not found`);
    }
    const next = all.find(h => h.index > target.index && h.level <= target.level);
    return [target.index, next ? next.index : content.length];
  }

  // ── Paragraph helpers (internal) ──────────────────────────────────────────

  _parseParagraphs(slice, baseOffset) {
    const HEADING_LINE = /^[ \t]*\\(section|subsection|subsubsection|paragraph)\*?\{/;
    const results      = [];
    const chunks       = slice.split(/(\n[ \t]*\n+)/);
    let pos            = 0;
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (trimmed && !HEADING_LINE.test(trimmed)) {
        results.push({ text: chunk, start: baseOffset + pos, end: baseOffset + pos + chunk.length });
      }
      pos += chunk.length;
    }
    return results;
  }

  _buildLocationIndex(content) {
    const headings = this._parseHeadings(content);
    return (pos, type) => {
      const candidates = headings.filter(h => h.type === type && h.index <= pos);
      return candidates.length ? candidates[candidates.length - 1].title : null;
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async listFiles(extension = '.tex') {
    await this.cloneOrPull();
    const { stdout } = await exec(
      `find "${this.repoPath}" -name "*${extension}" -not -path "*/.git/*" -type f`
    );
    return stdout.split('\n').filter(Boolean)
      .map(f => f.replace(this.repoPath + '/', ''));
  }

  async readFile(filePath) {
    return this.readRaw(filePath);
  }

  async getSections(filePath, typeFilter = null) {
    const content  = await this.readRaw(filePath);
    const headings = this._parseHeadings(content);
    return typeFilter ? headings.filter(h => typeFilter.includes(h.type)) : headings;
  }

  async getSectionContent(filePath, sectionTitle, sectionType = null) {
    const content      = await this.readRaw(filePath);
    const [start, end] = this._headingBounds(content, sectionTitle, sectionType);
    return content.substring(start, end);
  }

  async writeSection(filePath, sectionTitle, newContent, sectionType = null, commitMessage) {
    const content      = await this.readRaw(filePath);
    const [start, end] = this._headingBounds(content, sectionTitle, sectionType);
    const updated      = content.substring(0, start) + newContent + content.substring(end);
    return this.writeRaw(filePath, updated, commitMessage || `Update "${sectionTitle}" via MCP`);
  }

  async moveSection(filePath, sourceTitle, anchorTitle, position = 'before', sectionType = null, commitMessage) {
    const content = await this.readRaw(filePath);

    const [srcStart, srcEnd]   = this._headingBounds(content, sourceTitle, sectionType);
    const [anchorStart]        = this._headingBounds(content, anchorTitle, sectionType);

    if (srcStart === anchorStart) throw new Error('Source and anchor are the same heading.');

    const block         = content.substring(srcStart, srcEnd);
    const withoutSource = content.substring(0, srcStart) + content.substring(srcEnd);

    const [newAnchorStart, newAnchorEnd] = this._headingBounds(withoutSource, anchorTitle, sectionType);

    let updated;
    if (position === 'before') {
      updated = withoutSource.substring(0, newAnchorStart) + block + withoutSource.substring(newAnchorStart);
    } else {
      updated = withoutSource.substring(0, newAnchorEnd) + block + withoutSource.substring(newAnchorEnd);
    }

    return this.writeRaw(filePath, updated, commitMessage || `Move "${sourceTitle}" ${position} "${anchorTitle}" via MCP`);
  }

  async insertSection(filePath, anchorTitle, newContent, position = 'after', anchorType = null, commitMessage) {
    const content                  = await this.readRaw(filePath);
    const [anchorStart, anchorEnd] = this._headingBounds(content, anchorTitle, anchorType);
    const block                    = newContent.endsWith('\n') ? newContent : newContent + '\n';

    let updated;
    if (position === 'before') {
      updated = content.substring(0, anchorStart) + block + content.substring(anchorStart);
    } else {
      updated = content.substring(0, anchorEnd) + block + content.substring(anchorEnd);
    }

    return this.writeRaw(filePath, updated, commitMessage || `Insert block ${position} "${anchorTitle}" via MCP`);
  }

  async searchParagraphs(filePath, keywords, matchAll = false, sectionTitle = null, sectionType = null) {
    const content    = await this.readRaw(filePath);
    const locationAt = this._buildLocationIndex(content);

    let slice, baseOffset;
    if (sectionTitle) {
      const [start, end] = this._headingBounds(content, sectionTitle, sectionType);
      slice      = content.substring(start, end);
      baseOffset = start;
    } else {
      slice      = content;
      baseOffset = 0;
    }

    const paragraphs = this._parseParagraphs(slice, baseOffset);
    const normalized = keywords.map(k => k.toLowerCase());
    const results    = [];

    for (const para of paragraphs) {
      const lower   = para.text.toLowerCase();
      const matched = normalized.filter(k => lower.includes(k));
      const passes  = matchAll ? matched.length === normalized.length : matched.length > 0;
      if (!passes) continue;

      const location = {};
      for (const type of ['section', 'subsection', 'subsubsection', 'paragraph']) {
        const title = locationAt(para.start, type);
        if (title) location[type] = title;
      }
      results.push({ matchedKeywords: matched, location, text: para.text.trim() });
    }

    return results;
  }

  // ── BibTeX helpers ───────────────────────────────────────────────────────

  /**
   * Parse all BibTeX entries from content.
   * Returns array of { key, type, fields, rawText, start, end }
   */
  _parseBibEntries(content) {
    const entries = [];
    // Match @type{key, ... } — handles nested braces
    const typeKeyRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
    let m;
    while ((m = typeKeyRe.exec(content)) !== null) {
      const entryStart = m.index;
      // Walk forward to find the matching closing brace
      let depth = 0;
      let i = entryStart;
      let started = false;
      while (i < content.length) {
        if (content[i] === '{') { depth++; started = true; }
        else if (content[i] === '}') { depth--; }
        if (started && depth === 0) { i++; break; }
        i++;
      }
      const rawText = content.substring(entryStart, i);
      const fields  = {};
      // Parse fields: name = {value} or name = "value" or name = number
      const fieldRe = /(\w+)\s*=\s*(?:\{([^]*?)\}|"([^"]*)"|([\w\d]+))\s*[,}]/g;
      let fm;
      // search within rawText after the first comma
      const bodyStart = rawText.indexOf(',') + 1;
      const body = rawText.substring(bodyStart);
      while ((fm = fieldRe.exec(body)) !== null) {
        const fname = fm[1].toLowerCase();
        const fval  = fm[2] !== undefined ? fm[2] : (fm[3] !== undefined ? fm[3] : fm[4]);
        fields[fname] = fval;
      }
      entries.push({
        key:     m[2],
        type:    m[1].toLowerCase(),
        fields,
        rawText,
        start:   entryStart,
        end:     i,
      });
    }
    return entries;
  }

  // ── Paragraph deduplication ───────────────────────────────────────────────

  /**
   * Scan a file for duplicate \paragraph{...} names.
   * Keeps the first occurrence as-is; appends " 2", " 3", ... to later ones.
   * Returns { renamed: [{from, to, line}], content } — content is the updated text.
   * If dryRun is true, returns the same object but does NOT write to disk.
   */
  async dedupParagraphs(filePath, dryRun = false, commitMessage) {
    const content = await this.readRaw(filePath);
    // Collect all \paragraph{...} / \paragraph*{...} occurrences with positions
    const re = /\\paragraph(\*?)\{([^}]+)\}/g;
    const hits = [];
    let m;
    while ((m = re.exec(content)) !== null) {
      hits.push({ star: m[1], title: m[2], start: m.index, end: m.index + m[0].length });
    }
    // Group by title (case-sensitive, as LaTeX is)
    const seen = {};
    for (const h of hits) {
      seen[h.title] = (seen[h.title] || 0) + 1;
    }
    // Count occurrences as we walk so we can assign numbers
    const counter = {};
    const renamed = [];
    // Build list of replacements (process in order, apply back-to-front)
    const replacements = [];
    for (const h of hits) {
      counter[h.title] = (counter[h.title] || 0) + 1;
      if (counter[h.title] === 1) continue; // first occurrence — leave alone
      const newTitle = `${h.title} ${counter[h.title]}`;
      const newText  = `\\paragraph${h.star}{${newTitle}}`;
      replacements.push({ start: h.start, end: h.end, newText, from: h.title, to: newTitle });
      renamed.push({ from: `\\paragraph${h.star}{${h.title}}`, to: newText });
    }
    if (replacements.length === 0) {
      return { renamed: [], message: 'No duplicate \\paragraph names found.' };
    }
    // Apply back-to-front to preserve offsets
    let updated = content;
    for (const r of replacements.reverse()) {
      updated = updated.substring(0, r.start) + r.newText + updated.substring(r.end);
    }
    if (!dryRun) {
      await this.writeRaw(filePath, updated, commitMessage || `Deduplicate \\paragraph names via MCP`);
    }
    return { renamed, dryRun, message: `${renamed.length} paragraph(s) renamed.` };
  }

  async searchBibEntries(filePath, query, field = null, includeRaw = false) {
    const content = await this.readRaw(filePath);
    const entries = this._parseBibEntries(content);
    const q = query.toLowerCase();
    return entries.filter(e => {
      if (field) {
        const f = (e.fields[field.toLowerCase()] || '').toLowerCase();
        return f.includes(q);
      }
      if (e.key.toLowerCase().includes(q)) return true;
      return Object.values(e.fields).some(v => v.toLowerCase().includes(q));
    }).map(e => {
      const out = { key: e.key, type: e.type, fields: e.fields };
      if (includeRaw) out.rawText = e.rawText;
      return out;
    });
  }

  async getBibEntry(filePath, key) {
    const content = await this.readRaw(filePath);
    const entries = this._parseBibEntries(content);
    const entry   = entries.find(e => e.key.toLowerCase() === key.toLowerCase());
    if (!entry) throw new Error(`BibTeX entry "${key}" not found in ${filePath}`);
    return { key: entry.key, type: entry.type, fields: entry.fields, rawText: entry.rawText };
  }

  async writeBibEntry(filePath, key, newEntryText, commitMessage) {
    const content = await this.readRaw(filePath);
    const entries = this._parseBibEntries(content);
    const entry   = entries.find(e => e.key.toLowerCase() === key.toLowerCase());
    if (!entry) throw new Error(`BibTeX entry "${key}" not found in ${filePath}`);
    const updated = content.substring(0, entry.start) + newEntryText.trimEnd() + content.substring(entry.end);
    return this.writeRaw(filePath, updated, commitMessage || `Update BibTeX entry "${key}" via MCP`);
  }


  async updateBibField(filePath, key, field, value, commitMessage) {
    const content = await this.readRaw(filePath);
    const entries = this._parseBibEntries(content);
    const entry   = entries.find(e => e.key.toLowerCase() === key.toLowerCase());
    if (!entry) throw new Error(`BibTeX entry "${key}" not found in ${filePath}`);
    const fname   = field.toLowerCase();
    const fieldRe = new RegExp(
      `(\\b${fname}\\s*=\\s*)(?:\\{[^}]*\\}|"[^"]*"|[\\w\\d]+)`,
      'i'
    );
    let newRaw;
    if (fieldRe.test(entry.rawText)) {
      // Replace existing field value
      newRaw = entry.rawText.replace(fieldRe, `$1{${value}}`);
    } else {
      // Field doesn't exist — insert before the closing brace
      newRaw = entry.rawText.replace(/(\n?)\}(\s*)$/, `$1  ${fname} = {${value}},\n}$2`);
    }
    const updated = content.substring(0, entry.start) + newRaw + content.substring(entry.end);
    return this.writeRaw(filePath, updated, commitMessage || `Update "${key}.${field}" via MCP`);
  }

  // ── Line-level editing helpers ──────────────────────────────────────────

  _diffLines(oldLines, newLines, context = 1) {
    // unchanged lines are context (prefixed with space).
    const m = oldLines.length, n = newLines.length;
    const CONTEXT = (typeof context === 'number' && context >= 0) ? context : 1;
    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldLines[i] === newLines[j]) {
          dp[i][j] = 1 + dp[i + 1][j + 1];
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    // Trace back through LCS to produce edit operations
    // Each op: { type: 'eq'|'del'|'ins', oldIdx?, newIdx?, text }
    const ops = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && oldLines[i] === newLines[j]) {
        ops.push({ type: 'eq', oldIdx: i, newIdx: j, text: oldLines[i] });
        i++; j++;
      } else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
        ops.push({ type: 'ins', newIdx: j, text: newLines[j] });
        j++;
      } else {
        ops.push({ type: 'del', oldIdx: i, text: oldLines[i] });
        i++;
      }
    }

    // Identify which op indices are changed (del or ins)
    const changed = new Set();
    for (let k = 0; k < ops.length; k++) {
      if (ops[k].type !== 'eq') changed.add(k);
    }

    // Expand context window around changed ops
    const inContext = new Set();
    for (const k of changed) {
      for (let c = Math.max(0, k - CONTEXT); c <= Math.min(ops.length - 1, k + CONTEXT); c++) {
        inContext.add(c);
      }
    }

    // Build output — collapse long runs of omitted context into @@ markers
    const out = [];
    let lastIncluded = -1;
    for (let k = 0; k < ops.length; k++) {
      if (!inContext.has(k)) continue;
      if (lastIncluded >= 0 && k > lastIncluded + 1) {
        const skipped = k - lastIncluded - 1;
        out.push(`@@ -${(ops[lastIncluded].oldIdx ?? '?') + 1} +${skipped} lines skipped @@`);
      }
      const op = ops[k];
      if (op.type === 'eq')  out.push(` ${op.text}`);
      if (op.type === 'del') out.push(`-${op.text}`);
      if (op.type === 'ins') out.push(`+${op.text}`);
      lastIncluded = k;
    }

    if (out.length === 0) return '(no changes)';
    return out.join('\n');
  }

  async editFile(filePath, edits, dryRun = false, commitMessage, context = 1) {
    edits.forEach((edit, i) => {
      if (!Number.isFinite(edit.startLine)) {
        throw new Error(`edit_file: edits[${i}].startLine is required and must be a number (got ${JSON.stringify(edit.startLine)}). Provide the line number where this edit should start.`);
      }
    });
    await this.cloneOrPull();
    const content = await readFile(path.join(this.repoPath, filePath), 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    // Apply in reverse order so earlier line numbers stay valid after each splice
    const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);
    for (const edit of sorted) {
      const start       = Math.max(1, edit.startLine) - 1;  // convert to 0-indexed
      const end         = edit.endLine !== undefined ? Math.min(total, edit.endLine) : edit.startLine;
      const deleteCount = end - start;                       // number of lines to remove
      const replacement = edit.newText ? edit.newText.split('\n') : [];
      lines.splice(start, deleteCount, ...replacement);
    }
    const newContent = lines.join('\n');
    const diff = this._diffLines(content.split('\n'), newContent.split('\n'), context);
    if (!dryRun) {
      await writeFile(path.join(this.repoPath, filePath), newContent, 'utf-8');
      await this.commitAndPush(filePath, commitMessage || `Edit ${filePath} via MCP (${edits.length} edit(s))`);
    }
    return diff;
  }

  async readLines(filePath, start, end) {
    await this.cloneOrPull();
    const content = await readFile(path.join(this.repoPath, filePath), 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    const from = Math.max(1, start);
    const to   = end !== undefined ? Math.min(end, total) : total;
    return { lines: lines.slice(from - 1, to), from, to, total };
  }

  async findInFile(filePath, searchText, { caseSensitive = false, context = 0 } = {}) {
    await this.cloneOrPull();
    const content = await readFile(path.join(this.repoPath, filePath), 'utf-8');
    const lines   = content.split('\n');
    const matches = _multilineSearch(lines, searchText, caseSensitive);
    if (context === 0) return matches;
    return matches.map(m => {
      const ctxStart = Math.max(0, m.startLine - 1 - context);
      const ctxEnd   = Math.min(lines.length - 1, m.endLine - 1 + context);
      const contextLines = [];
      for (let c = ctxStart; c <= ctxEnd; c++) {
        contextLines.push({ line: c + 1, text: lines[c], isMatch: c >= m.startLine - 1 && c <= m.endLine - 1 });
      }
      return { ...m, contextLines };
    });
  }

  async replaceLines(filePath, start, end, newContent, commitMessage) {
    if (!Number.isFinite(start)) {
      throw new Error(`replace_lines: 'start' is required and must be a number (got ${JSON.stringify(start)}).`);
    }
    if (!Number.isFinite(end)) {
      throw new Error(`replace_lines: 'end' is required and must be a number (got ${JSON.stringify(end)}).`);
    }
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    const from = Math.max(1, start) - 1;
    const to   = Math.min(end, total);
    const replacedLines = to - from;
    const newLines = newContent.split('\n');
    lines.splice(from, replacedLines, ...newLines);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Replace lines ${start}-${end} in ${filePath} via MCP`);
    return { replacedLines, newLines: newLines.length, total: lines.length };
  }

  async insertLines(filePath, afterLine, content, commitMessage) {
    if (!Number.isFinite(afterLine)) {
      throw new Error(`insert_lines: 'after_line' is required and must be a number (got ${JSON.stringify(afterLine)}). Use 0 to insert at the beginning of the file.`);
    }
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    const existing = await readFile(fullPath, 'utf-8');
    const lines = existing.split('\n');
    const newLines = content.split('\n');
    lines.splice(afterLine, 0, ...newLines);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Insert lines after ${afterLine} in ${filePath} via MCP`);
    return { insertedLines: newLines.length, total: lines.length };
  }

  async deleteLines(filePath, start, end, commitMessage) {
    if (!Number.isFinite(start)) {
      throw new Error(`delete_lines: 'start' is required and must be a number (got ${JSON.stringify(start)}).`);
    }
    if (!Number.isFinite(end)) {
      throw new Error(`delete_lines: 'end' is required and must be a number (got ${JSON.stringify(end)}).`);
    }
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const from = Math.max(1, start) - 1;
    const to   = Math.min(end, lines.length);
    const deletedLines = to - from;
    lines.splice(from, deletedLines);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Delete lines ${start}-${end} in ${filePath} via MCP`);
    return { deletedLines, total: lines.length };
  }

  async copyLines(filePath, start, end, insertAfterLine, commitMessage) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    const content  = await readFile(fullPath, 'utf-8');
    const lines    = content.split('\n');
    const from     = Math.max(1, start) - 1;          // 0-indexed start
    const blockLen = Math.min(end, lines.length) - from;
    if (blockLen <= 0) throw new Error(`copy_lines: invalid range ${start}-${end}`);
    const block    = lines.slice(from, from + blockLen);
    const insertAt = Math.min(Math.max(0, insertAfterLine), lines.length);
    lines.splice(insertAt, 0, ...block);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Copy lines ${start}-${end} to after line ${insertAfterLine} in ${filePath} via MCP`);
    return { copiedLines: blockLen, insertedAfter: insertAfterLine, total: lines.length };
  }

  async moveLines(filePath, start, end, insertAfterLine, commitMessage) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    const content  = await readFile(fullPath, 'utf-8');
    const lines    = content.split('\n');
    const from     = Math.max(1, start) - 1;
    const blockLen = Math.min(end, lines.length) - from;
    if (blockLen <= 0) throw new Error(`move_lines: invalid range ${start}-${end}`);
    if (insertAfterLine >= start && insertAfterLine <= end)
      throw new Error(`move_lines: insertAfterLine (${insertAfterLine}) is inside the source range (${start}-${end})`);
    const block = lines.splice(from, blockLen);  // remove block
    // Adjust destination for the removal
    const insertAt = insertAfterLine > from
      ? Math.max(from, insertAfterLine - blockLen)
      : insertAfterLine;
    lines.splice(insertAt, 0, ...block);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Move lines ${start}-${end} to after line ${insertAfterLine} in ${filePath} via MCP`);
    return { movedLines: blockLen, insertedAfter: insertAt, total: lines.length };
  }



  async appendToFile(filePath, content, commitMessage) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    await appendFile(fullPath, content, 'utf-8');
    await this.commitAndPush(filePath, commitMessage || `Append to ${filePath} via MCP`);
  }

  async findInFiles(dirPath, searchText, { caseSensitive = false, filePattern = null, excludePatterns = [] } = {}) {
    await this.cloneOrPull();
    const absDir = dirPath ? path.join(this.repoPath, dirPath) : this.repoPath;
    const results = [];
    const extRe   = filePattern ? new RegExp(filePattern.replace('*', '.*').replace('.', '\\.') + '$') : null;
    const walk    = async (dir) => {
      let entries;
      try { entries = await (await import('fs/promises')).readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || excludePatterns.includes(entry.name)) continue;
          await walk(full);
        } else {
          if (extRe && !extRe.test(entry.name)) continue;
          let content;
          try { content = await readFile(full, 'utf-8'); } catch { continue; }
          const relFile = full.replace(this.repoPath + '/', '');
          const lines   = content.split('\n');
          const matches = _multilineSearch(lines, searchText, caseSensitive);
          for (const m of matches) {
            results.push({ file: relFile, startLine: m.startLine, endLine: m.endLine, matchText: m.matchText });
          }
        }
      }
    };
    await walk(absDir);
    return results;
  }

  async _pathExists(relFilePath) {
    await this.cloneOrPull();
    try {
      await access(path.join(this.repoPath, relFilePath));
      return true;
    } catch {
      return false;
    }
  }

  // Finds the next available "name (1).ext", "name (2).ext", ... path that does
  // not collide with an existing file in the project. Never overwrites.
  async findAvailablePath(relFilePath) {
    if (!(await this._pathExists(relFilePath))) return relFilePath;
    const dir  = path.dirname(relFilePath);
    const ext  = path.extname(relFilePath);
    const base = path.basename(relFilePath, ext);
    let n = 1;
    let candidate;
    do {
      candidate = dir === '.' ? `${base} (${n})${ext}` : path.join(dir, `${base} (${n})${ext}`);
      n++;
    } while (await this._pathExists(candidate));
    return candidate;
  }

  // Creates a file. NEVER overwrites an existing one — if filePath already
  // exists, writes to an incremented filename instead and reports the redirect.
  async createFile(filePath, content = '', commitMessage = 'Create file via MCP') {
    const existed = await this._pathExists(filePath);
    if (!existed) {
      const result = await this.writeRaw(filePath, content, commitMessage);
      return { message: result, path: filePath, redirected: false };
    }
    const altPath = await this.findAvailablePath(filePath);
    const result  = await this.writeRaw(altPath, content, commitMessage || `Create ${altPath} via MCP`);
    return { message: result, path: altPath, redirected: true, originalPath: filePath };
  }



  async copyFile(srcPath, destPath, commitMessage) {
    const content = await this.readRaw(srcPath);
    return this.writeRaw(destPath, content, commitMessage || `Copy "${srcPath}" to "${destPath}" via MCP`);
  }

  async deleteFile(filePath, commitMessage = 'Delete file via MCP') {
    await this.cloneOrPull();
    await exec(
      `cd "${this.repoPath}" && git rm "${filePath}" && git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    const { stdout } = await exec(
      `cd "${this.repoPath}" && git push "${this.gitUrlWithAuth}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    return `"${filePath}" deleted and pushed.\n${stdout}`;
  }
}


// ── Multi-line search helper ─────────────────────────────────────────────────
// Matches searchText against file lines with whitespace-normalized matching so
// phrases split across two lines (e.g. at 80-char wrap) are still found.
// Returns [{ startLine, endLine, matchText }] (1-indexed, inclusive).
function _multilineSearch(lines, searchText, caseSensitive = false) {
  const norm = s => (caseSensitive ? s : s.toLowerCase()).replace(/\s+/g, ' ');
  const needle = norm(searchText).trim();
  if (!needle) return [];

  // Build a flat string (newlines → space) and a parallel array mapping each
  // character in the flat string back to its 1-indexed source line number.
  const lineOf  = [];
  const flatArr = [];
  for (let li = 0; li < lines.length; li++) {
    for (const ch of lines[li]) { lineOf.push(li + 1); flatArr.push(ch); }
    if (li < lines.length - 1) { lineOf.push(li + 1); flatArr.push('\n'); }
  }

  // Build a whitespace-normalised version of the flat string, tracking which
  // original flat-index each normalised character came from.
  const normToOrig = [];
  let normFlat     = '';
  let prevSpace    = true; // treat start as after-space so leading space is trimmed
  for (let i = 0; i < flatArr.length; i++) {
    const isWS = /\s/.test(flatArr[i]);
    if (isWS) {
      if (!prevSpace) { normToOrig.push(i); normFlat += ' '; }
      prevSpace = true;
    } else {
      normToOrig.push(i);
      normFlat += caseSensitive ? flatArr[i] : flatArr[i].toLowerCase();
      prevSpace = false;
    }
  }

  const results = [];
  let pos = 0;
  while (pos < normFlat.length) {
    const idx = normFlat.indexOf(needle, pos);
    if (idx === -1) break;
    const origStart = normToOrig[idx];
    const origEnd   = normToOrig[Math.min(idx + needle.length - 1, normToOrig.length - 1)];
    const startLine = lineOf[origStart];
    const endLine   = lineOf[origEnd];
    results.push({ startLine, endLine, matchText: lines.slice(startLine - 1, endLine).join('\n') });
    pos = idx + 1;
  }
  return results;
}


// ── MCP server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'overleaf-mcp-server', version: '1.10.0' },
  { capabilities: { tools: {} } }
);

function getProject(projectName = 'default') {
  const project = projectsConfig.projects[projectName];
  if (!project) throw new Error(`Project "${projectName}" not found in configuration`);
  return new OverleafGitClient(project.projectId, project.gitToken);

async function copyLinesBetweenFiles(sourceProjectName, sourceFilePath, start, end, destProjectName, destFilePath, insertAfterLine, commitMessage) {
  const sourceClient = getProject(sourceProjectName);
  const destClient    = sourceProjectName === destProjectName ? sourceClient : getProject(destProjectName);

  await sourceClient.cloneOrPull();
  const sourceFullPath = path.join(sourceClient.repoPath, sourceFilePath);
  const sourceContent  = await readFile(sourceFullPath, 'utf-8');
  const sourceLines    = sourceContent.split('\n');
  const from           = Math.max(1, start) - 1;
  const blockLen       = Math.min(end, sourceLines.length) - from;
  if (blockLen <= 0) throw new Error(`copy_lines_between_files: invalid range ${start}-${end}`);
  const block          = sourceLines.slice(from, from + blockLen);

  await destClient.cloneOrPull();
  const destFullPath = path.join(destClient.repoPath, destFilePath);
  let destLines;
  try {
    const destContent = await readFile(destFullPath, 'utf-8');
    destLines = destContent.split('\n');
  } catch (err) {
    if (err.code === 'ENOENT') destLines = [''];
    else throw err;
  }
  const insertAt = Math.min(Math.max(0, insertAfterLine), destLines.length);
  destLines.splice(insertAt, 0, ...block);

  await writeFile(destFullPath, destLines.join('\n'), 'utf-8');
  await destClient.commitAndPush(destFilePath, commitMessage || `Copy lines ${start}-${end} from ${sourceFilePath} into ${destFilePath} via MCP`);
  return { copiedLines: blockLen, insertedAfter: insertAfterLine, destTotal: destLines.length };
}

async function moveLinesBetweenFiles(sourceProjectName, sourceFilePath, start, end, destProjectName, destFilePath, insertAfterLine, commitMessage) {
  const sourceClient = getProject(sourceProjectName);
  const destClient    = sourceProjectName === destProjectName ? sourceClient : getProject(destProjectName);

  await sourceClient.cloneOrPull();
  const sourceFullPath = path.join(sourceClient.repoPath, sourceFilePath);
  const sourceContent  = await readFile(sourceFullPath, 'utf-8');
  const sourceLines    = sourceContent.split('\n');
  const from           = Math.max(1, start) - 1;
  const blockLen       = Math.min(end, sourceLines.length) - from;
  if (blockLen <= 0) throw new Error(`move_lines_between_files: invalid range ${start}-${end}`);
  const block          = sourceLines.splice(from, blockLen);

  await destClient.cloneOrPull();
  const destFullPath = path.join(destClient.repoPath, destFilePath);
  let destLines;
  try {
    const destContent = await readFile(destFullPath, 'utf-8');
    destLines = destContent.split('\n');
  } catch (err) {
    if (err.code === 'ENOENT') destLines = [''];
    else throw err;
  }
  const insertAt = Math.min(Math.max(0, insertAfterLine), destLines.length);
  destLines.splice(insertAt, 0, ...block);

  // Write + push destination first; only remove from source after dest succeeds (avoid data loss)
  await writeFile(destFullPath, destLines.join('\n'), 'utf-8');
  await destClient.commitAndPush(destFilePath, commitMessage || `Copy lines ${start}-${end} from ${sourceFilePath} into ${destFilePath} via MCP`);

  await writeFile(sourceFullPath, sourceLines.join('\n'), 'utf-8');
  await sourceClient.commitAndPush(sourceFilePath, commitMessage || `Remove moved lines ${start}-${end} from ${sourceFilePath} via MCP`);

  return { movedLines: blockLen, insertedAfter: insertAfterLine, destTotal: destLines.length, sourceTotal: sourceLines.length };
}


const filePathProp    = { type: 'string', description: 'Path to the file (relative to project root)' };
const projectNameProp = { type: 'string', description: 'Project identifier (optional, defaults to "default")' };
const commitMsgProp   = { type: 'string', description: 'Git commit message (optional)' };
const sectionTypeProp = {
  type: 'string',
  enum: ['section', 'subsection', 'subsubsection', 'paragraph'],
  description: 'Heading level (optional). Use to disambiguate when the same title exists at multiple levels.',
};
const sectionTitleProp = { type: 'string', description: 'Exact heading text (content inside the curly braces)' };
const positionProp     = {
  type: 'string',
  enum: ['before', 'after'],
  description: 'Whether to place the block before or after the anchor heading',
};

// ── Tool definitions ─────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ── File-level ────────────────────────────────────────────────────────
    {
      name: 'list_projects',
      description: 'List all configured Overleaf projects',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_files',
      description: 'List files in an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: projectNameProp,
              extension: { type: 'string', description: 'File extension filter (optional, e.g. ".tex" or ".bib". Defaults to ".tex")' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read the full contents of a file. Prefer get_section_content or get_preamble for targeted reads.',
      inputSchema: {
        type: 'object',
        properties: { filePath: filePathProp, projectName: projectNameProp },
        required: ['filePath'],
      },
    },
    {
      name: 'status_summary',
      description: 'Project overview: file list and heading counts by level',
      inputSchema: {
        type: 'object',
        properties: { projectName: projectNameProp },
      },
    },
    {
      name: 'create_file',
      description: 'Create a new file in the project and push it to Overleaf. NEVER overwrites an existing file — if filePath already exists, the content is automatically saved instead to an incremented filename (e.g. "name (1).tex"), and the response flags this.', 
      inputSchema: {
        type: 'object',
        properties: {
          filePath: filePathProp,
          content: { type: 'string', description: 'Initial file content (optional)' },
          commitMessage: commitMsgProp,
          projectName: projectNameProp,
        },
        required: ['filePath'],
      },
    },
    {
      name: 'copy_file',
      description: 'Copy a file within the project without passing content through the agent.',
      inputSchema: {
        type: 'object',
        properties: {
          srcPath:       { type: 'string', description: 'Source file path (relative to project root)' },
          destPath:      { type: 'string', description: 'Destination file path (relative to project root)' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['srcPath', 'destPath'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file from the project and push to Overleaf',
      inputSchema: {
        type: 'object',
        properties: { filePath: filePathProp, commitMessage: commitMsgProp, projectName: projectNameProp },
        required: ['filePath'],
      },
    },

    // ── Preamble ──────────────────────────────────────────────────────────
    {
      name: 'get_preamble',
      description: 'Read everything before \\begin{document} in a root .tex file. Use this to inspect packages, custom commands, and document class settings.',
      inputSchema: {
        type: 'object',
        properties: { filePath: filePathProp, projectName: projectNameProp },
        required: ['filePath'],
      },
    },
    {
      name: 'write_preamble',
      description: 'Replace everything before \\begin{document} and push. \\begin{document} and the document body are preserved exactly. newPreamble must NOT include \\begin{document}.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:     filePathProp,
          newPreamble:  { type: 'string', description: 'Full replacement preamble (must not include \\begin{document})' },
          commitMessage: commitMsgProp,
          projectName:  projectNameProp,
        },
        required: ['filePath', 'newPreamble'],
      },
    },

    // ── Section / paragraph level ─────────────────────────────────────────
    {
      name: 'get_sections',
      description: 'List headings in a LaTeX file. Omitting sectionType hides \\paragraph{} headings for a clean structural view.',
      inputSchema: {
        type: 'object',
        properties: { filePath: filePathProp, sectionType: sectionTypeProp, projectName: projectNameProp },
        required: ['filePath'],
      },
    },
    {
      name: 'get_section_content',
      description: 'Read the LaTeX source of a named heading block (heading line + all content up to the next equal-or-higher heading). Works for all levels.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: filePathProp,
          sectionTitle: sectionTitleProp,
          sectionType: sectionTypeProp,
          projectName: projectNameProp,
        },
        required: ['filePath', 'sectionTitle'],
      },
    },
    {
      name: 'write_section',
      description: 'Replace a heading block in-place and push. newContent must include the opening heading command. Only the targeted block is replaced.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: filePathProp,
          sectionTitle: sectionTitleProp,
          newContent: { type: 'string', description: 'Full replacement including the heading line' },
          sectionType: sectionTypeProp,
          commitMessage: commitMsgProp,
          projectName: projectNameProp,
        },
        required: ['filePath', 'sectionTitle', 'newContent'],
      },
    },
    {
      name: 'move_section',
      description: 'Move a heading block to immediately before or after another heading in one atomic operation. Use this instead of manual cut-and-paste when reordering.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          sourceTitle:   { type: 'string', description: 'Title of the heading block to move' },
          anchorTitle:   { type: 'string', description: 'Title of the reference heading to move relative to' },
          position:      positionProp,
          sectionType:   { ...sectionTypeProp, description: 'Heading level — applies to both source and anchor' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'sourceTitle', 'anchorTitle', 'position'],
      },
    },
    {
      name: 'insert_section',
      description: 'Insert a new block immediately before or after a named heading. newContent must include the heading command if creating a named block. Nothing else is touched.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          anchorTitle:   { type: 'string', description: 'Title of the heading to insert relative to' },
          newContent:    { type: 'string', description: 'Content to insert (include heading line if creating a named block)' },
          position:      positionProp,
          anchorType:    { ...sectionTypeProp, description: 'Heading level of the anchor (optional, for disambiguation)' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'anchorTitle', 'newContent', 'position'],
      },
    },

    // ── Paragraph dedup ───────────────────────────────────────────────────────
    {
      name: 'dedup_paragraphs',
      description: 'Scan a .tex file for duplicate \\paragraph{} names and rename them by appending " 2", " 3", etc. First occurrence keeps its name. Use dryRun:true to preview changes without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          dryRun:        { type: 'boolean', description: 'Preview changes without writing (default: false)' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath'],
      },
    },

    // ── BibTeX ───────────────────────────────────────────────────────────────
    {
      name: 'search_bib_entries',
      description: 'Search BibTeX entries in a .bib file by any field value or citation key (case-insensitive, partial match). Optionally scope to a specific field (e.g. "title", "author"). By default returns structured fields only; set includeRaw:true to also get the full raw BibTeX text.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:    filePathProp,
          query:       { type: 'string', description: 'Search string (partial match, case-insensitive)' },
          field:       { type: 'string', description: 'Limit search to this field name, e.g. "title" or "author" (optional)' },
          includeRaw:  { type: 'boolean', description: 'Include full rawText in results (default: false)' },
          projectName: projectNameProp,
        },
        required: ['filePath', 'query'],
      },
    },
    {
      name: 'get_bib_entry',
      description: 'Retrieve a single BibTeX entry by its citation key.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:    filePathProp,
          key:         { type: 'string', description: 'Citation key (e.g. "smith2020")' },
          projectName: projectNameProp,
        },
        required: ['filePath', 'key'],
      },
    },
    {
      name: 'write_bib_entry',
      description: 'Replace a single BibTeX entry in-place and push to Overleaf. Only the targeted entry is modified. Provide the full replacement entry text including @type{key, ...}.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:     filePathProp,
          key:          { type: 'string', description: 'Citation key of the entry to replace' },
          newEntryText: { type: 'string', description: 'Full replacement BibTeX entry text' },
          commitMessage: commitMsgProp,
          projectName:  projectNameProp,
        },
        required: ['filePath', 'key', 'newEntryText'],
      },
    },
    {
      name: 'update_bib_field',
      description: 'Update or add a single field in a BibTeX entry without touching anything else. Prefer this over write_bib_entry for simple field changes (year, doi, url, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:     filePathProp,
          key:          { type: 'string', description: 'Citation key of the entry to update' },
          field:        { type: 'string', description: 'Field name to set, e.g. "year", "doi", "url"' },
          value:        { type: 'string', description: 'New value for the field (without surrounding braces)' },
          commitMessage: commitMsgProp,
          projectName:  projectNameProp,
        },
        required: ['filePath', 'key', 'field', 'value'],
      },
    },


    // ── Line-level editing ─────────────────────────────────────────────────
    {
      name: 'edit_file',
      description: 'Make targeted line-based edits to a file. Each edit replaces a line range with new content (which may span any number of lines). Edits are applied in reverse line order so indices stay stable. Returns a git-style diff. Use dryRun:true to preview without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          edits: {
            type: 'array',
            description: 'List of line-range replacements — applied in reverse order so earlier line numbers stay valid',
            items: {
              type: 'object',
              properties: {
                startLine: { type: 'integer', minimum: 1, description: 'First line to replace (1-indexed, inclusive)' },
                endLine:   { type: 'integer', description: 'Last line to replace (1-indexed, inclusive). Defaults to startLine for single-line replacement.' },
                newText:   { type: 'string',  description: 'Replacement text. Can be multiline. Omit or use empty string to delete the lines.' },
              },
              required: ['startLine'],
            },
          },
          dryRun:        { type: 'boolean', description: 'Preview diff without writing (default: false)' },
          context:       { type: 'integer', minimum: 0, description: 'Lines of context shown around each changed hunk in the returned diff (default: 2). Increase to verify edits landed correctly.' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'edits'],
      },
    },
    {
      name: 'read_lines',
      description: 'Read a specific range of lines from a file by line number, with line numbers shown. Use find_in_file first to locate the relevant line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:    filePathProp,
          start:       { type: 'integer', minimum: 1, description: 'First line to read (1-indexed)' },
          end:         { type: 'integer', description: 'Last line to read (inclusive). Omit to read to end of file.' },
          projectName: projectNameProp,
        },
        required: ['filePath', 'start'],
      },
    },
    {
      name: 'find_in_file',
      description: 'Search for a phrase within a single file. Handles phrases split across lines (e.g. at 80-char wrap) by matching with whitespace normalization. Returns startLine, endLine, and matchText for each hit. Use context for surrounding lines. Use before read_lines or edit_file to locate exactly where something is.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          text:          { type: 'string', description: 'Text to search for. Whitespace (including newlines) is normalized, so multi-word phrases find matches even if split across lines.' },
          caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
          context:       { type: 'integer', minimum: 0, description: 'Lines of context above and below each match (default: 0)' },
          projectName:   projectNameProp,
        },
        required: ['filePath', 'text'],
      },
    },
    {
      name: 'replace_lines',
      description: 'Replace a range of lines in a file by line number and push. More efficient than edit_file when you already know the exact line numbers from find_in_file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          start:         { type: 'integer', minimum: 1, description: 'First line to replace (1-indexed)' },
          end:           { type: 'integer', description: 'Last line to replace (inclusive)' },
          content:       { type: 'string', description: 'New content to replace the line range with' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'start', 'end', 'content'],
      },
    },
    {
      name: 'insert_lines',
      description: 'Insert new content after a specific line number and push. Use line 0 to insert at the beginning of the file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          after_line:    { type: 'integer', minimum: 0, description: 'Insert after this line number. Use 0 to insert at the beginning.' },
          content:       { type: 'string', description: 'Content to insert' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'after_line', 'content'],
      },
    },
    {
      name: 'delete_lines',
      description: 'Delete a range of lines from a file by line number and push.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          start:         { type: 'integer', minimum: 1, description: 'First line to delete (1-indexed)' },
          end:           { type: 'integer', description: 'Last line to delete (inclusive)' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'start', 'end'],
      },
    },
    {
      name: 'copy_lines',
      description: 'Copy a range of lines and insert the copy after a given line number. Original lines are preserved. Use with move_lines to reorganise content without rewriting.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:        filePathProp,
          start:           { type: 'integer', minimum: 1, description: 'First line of the block to copy (1-indexed, inclusive)' },
          end:             { type: 'integer', description: 'Last line of the block to copy (1-indexed, inclusive)' },
          insertAfterLine: { type: 'integer', minimum: 0, description: 'Insert the copied block after this line number. Use 0 to insert at the very beginning.' },
          commitMessage:   commitMsgProp,
          projectName:     projectNameProp,
        },
        required: ['filePath', 'start', 'end', 'insertAfterLine'],
      },
    },
    {
      name: 'move_lines',
      description: 'Move a range of lines to after a given line number (cut and paste). Line numbers are adjusted automatically for the removal. Throws if insertAfterLine falls inside the source range.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:        filePathProp,
          start:           { type: 'integer', minimum: 1, description: 'First line of the block to move (1-indexed, inclusive)' },
          end:             { type: 'integer', description: 'Last line of the block to move (1-indexed, inclusive)' },
          insertAfterLine: { type: 'integer', minimum: 0, description: 'Insert the block after this line number in the post-removal file. Use 0 to move to the very beginning.' },
          commitMessage:   commitMsgProp,
          projectName:     projectNameProp,
        },
        required: ['filePath', 'start', 'end', 'insertAfterLine'],
      },
    },
    {
      name: 'copy_lines_between_files',
      description: 'Copy a range of lines from one file and insert the copy into a different file after a given line number. Original lines in the source are preserved. Source and destination can be in the same or different Overleaf projects. Use to combine content from two files without manually rewriting either.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceFilePath:   filePathProp,
          sourceProjectName: { type: 'string', description: 'Source project identifier (optional, defaults to "default")' },
          start:            { type: 'integer', minimum: 1, description: 'First line of the block to copy in the source file (1-indexed, inclusive)' },
          end:              { type: 'integer', description: 'Last line of the block to copy in the source file (1-indexed, inclusive)' },
          destFilePath:     { type: 'string', description: 'Destination file path (relative to destination project root). Created if it does not exist.' },
          destProjectName:  { type: 'string', description: 'Destination project identifier (optional, defaults to "default")' },
          insertAfterLine:  { type: 'integer', minimum: 0, description: 'Insert the copied block after this line number in the destination file. Use 0 to insert at the very beginning.' },
          commitMessage:    commitMsgProp,
        },
        required: ['sourceFilePath', 'start', 'end', 'destFilePath', 'insertAfterLine'],
      },
    },
    {
      name: 'move_lines_between_files',
      description: 'Move (cut and paste) a range of lines from one file into a different file after a given line number. The lines are removed from the source file. Source and destination can be in the same or different Overleaf projects. Use to combine or split files without manually rewriting either.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceFilePath:   filePathProp,
          sourceProjectName: { type: 'string', description: 'Source project identifier (optional, defaults to "default")' },
          start:            { type: 'integer', minimum: 1, description: 'First line of the block to move in the source file (1-indexed, inclusive)' },
          end:              { type: 'integer', description: 'Last line of the block to move in the source file (1-indexed, inclusive)' },
          destFilePath:     { type: 'string', description: 'Destination file path (relative to destination project root). Created if it does not exist.' },
          destProjectName:  { type: 'string', description: 'Destination project identifier (optional, defaults to "default")' },
          insertAfterLine:  { type: 'integer', minimum: 0, description: 'Insert the block after this line number in the destination file. Use 0 to insert at the very beginning.' },
          commitMessage:    commitMsgProp,
        },
        required: ['sourceFilePath', 'start', 'end', 'destFilePath', 'insertAfterLine'],
      },
    },

    {
      name: 'append_to_file',
      description: 'Append content to the end of a file and push. More efficient than write_section when you just need to add to the end.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:      filePathProp,
          content:       { type: 'string', description: 'Content to append' },
          commitMessage: commitMsgProp,
          projectName:   projectNameProp,
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'find_in_files',
      description: 'Search for a text string recursively across all files in the project. Returns each matching file path, line number, and matching line. Optionally filter by glob pattern or exclude paths.',
      inputSchema: {
        type: 'object',
        properties: {
          dirPath:         { type: 'string', description: 'Subdirectory to search in (relative to project root). Omit to search entire project.' },
          text:            { type: 'string', description: 'Text to search for' },
          filePattern:     { type: 'string', description: "Glob pattern to filter files, e.g. '*.tex'" },
          caseSensitive:   { type: 'boolean', description: 'Case-sensitive search (default: false)' },
          excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Directory names to exclude' },
          projectName:     projectNameProp,
        },
        required: ['text'],
      },
    },

    // ── Search ────────────────────────────────────────────────────────────
    {
      name: 'search_paragraphs',
      description: 'Search for keywords across all paragraphs. Each matching paragraph is returned exactly once with matched keywords and a location breadcrumb. matchAll:true requires ALL keywords (AND); default is OR.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: filePathProp,
          keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for (case-insensitive)' },
          matchAll: { type: 'boolean', description: 'Require ALL keywords (AND logic). Default: false.' },
          sectionTitle: { type: 'string', description: 'Scope search to this section only (optional)' },
          sectionType: sectionTypeProp,
          projectName: projectNameProp,
        },
        required: ['filePath', 'keywords'],
      },
    },
  ],
}));

// ── Tool call handler ────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {

      case 'list_projects': {
        const projects = Object.entries(projectsConfig.projects).map(([key, p]) => ({
          id: key, name: p.name, projectId: p.projectId,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
      }

      case 'list_files': {
        const c     = getProject(args.projectName);
        const files = await c.listFiles(args.extension || '.tex');
        return { content: [{ type: 'text', text: files.join('\n') }] };
      }

      case 'read_file': {
        const c       = getProject(args.projectName);
        const content = await c.readFile(args.filePath);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'status_summary': {
        const c      = getProject(args.projectName);
        const files  = await c.listFiles();
        const main   = files.find(f => f.includes('main.tex')) || files[0];
        let headings = [];
        if (main) headings = await c.getSections(main);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalFiles: files.length,
              mainFile: main,
              headings: {
                total:          headings.length,
                sections:       headings.filter(h => h.type === 'section').length,
                subsections:    headings.filter(h => h.type === 'subsection').length,
                subsubsections: headings.filter(h => h.type === 'subsubsection').length,
                paragraphs:     headings.filter(h => h.type === 'paragraph').length,
              },
              files: files.slice(0, 10),
            }, null, 2),
          }],
        };
      }

      case 'create_file': {
        const c = getProject(args.projectName);
        const result = await c.createFile(args.filePath, args.content || '', args.commitMessage || `Create ${args.filePath} via MCP`);
        if (result.redirected) {
          const text = `File "${result.originalPath}" already exists — nothing was overwritten. Content was saved instead to "${result.path}". If you intended to add this content to the existing file, use copy_lines_between_files or move_lines_between_files (or append_to_file / write_section) to insert it from "${result.path}" into "${result.originalPath}", then delete "${result.path}" once merged.`;
          return { content: [{ type: 'text', text }], isError: true };
        }
        return { content: [{ type: 'text', text: result.message }] };
      }


      case 'copy_file': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.copyFile(args.srcPath, args.destPath, args.commitMessage) }] };
      }

      case 'delete_file': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.deleteFile(args.filePath, args.commitMessage || `Delete ${args.filePath} via MCP`) }] };
      }

      case 'get_preamble': {
        const c       = getProject(args.projectName);
        const content = await c.getPreamble(args.filePath);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'write_preamble': {
        const c      = getProject(args.projectName);
        const result = await c.writePreamble(args.filePath, args.newPreamble, args.commitMessage);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'get_sections': {
        const c          = getProject(args.projectName);
        const typeFilter = args.sectionType ? [args.sectionType] : ['section', 'subsection', 'subsubsection'];
        const sections   = await c.getSections(args.filePath, typeFilter);
        return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
      }

      case 'get_section_content': {
        const c       = getProject(args.projectName);
        const content = await c.getSectionContent(args.filePath, args.sectionTitle, args.sectionType || null);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'write_section': {
        const c = getProject(args.projectName);
        try {
          return { content: [{ type: 'text', text: await c.writeSection(args.filePath, args.sectionTitle, args.newContent, args.sectionType || null, args.commitMessage) }] };
        } catch (err) {
          if (err.message && err.message.includes('not found')) {
            // Heading absent — safe fallback: append to end of file
            // Read current line count first so we can report the exact range
            const existingContent = await c.readRaw(args.filePath);
            const existingLines   = existingContent.split('\n').length;
            const appendedLines   = ('\n' + args.newContent).split('\n').length - 1;
            const startLine       = existingLines + 1;
            const endLine         = existingLines + appendedLines;
            await c.appendToFile(args.filePath, '\n' + args.newContent, args.commitMessage || `Append "${args.sectionTitle}" via MCP`);
            return { content: [{ type: 'text', text: `[write_section fallback: heading "${args.sectionTitle}" not found — content appended to end of file. Starts at line ${startLine}, ends at line ${endLine}.]` }] };
          }
          throw err;
        }
      }

      case 'move_section': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.moveSection(args.filePath, args.sourceTitle, args.anchorTitle, args.position || 'before', args.sectionType || null, args.commitMessage) }] };
      }

      case 'insert_section': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.insertSection(args.filePath, args.anchorTitle, args.newContent, args.position || 'after', args.anchorType || null, args.commitMessage) }] };
      }

      case 'dedup_paragraphs': {
        const c      = getProject(args.projectName);
        const result = await c.dedupParagraphs(args.filePath, args.dryRun ?? false, args.commitMessage);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'search_bib_entries': {
        const c       = getProject(args.projectName);
        const results = await c.searchBibEntries(args.filePath, args.query, args.field || null, args.includeRaw ?? false);
        return { content: [{ type: 'text', text: `${results.length} entry/entries matched.\n\n` + JSON.stringify(results, null, 2) }] };
      }

      case 'get_bib_entry': {
        const c     = getProject(args.projectName);
        const entry = await c.getBibEntry(args.filePath, args.key);
        return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
      }

      case 'write_bib_entry': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.writeBibEntry(args.filePath, args.key, args.newEntryText, args.commitMessage) }] };
      }

      case 'update_bib_field': {
        const c = getProject(args.projectName);
        return { content: [{ type: 'text', text: await c.updateBibField(args.filePath, args.key, args.field, args.value, args.commitMessage) }] };
      }

      case 'search_paragraphs': {
        const c       = getProject(args.projectName);
        const results = await c.searchParagraphs(args.filePath, args.keywords, args.matchAll ?? false, args.sectionTitle || null, args.sectionType || null);
        return { content: [{ type: 'text', text: `${results.length} paragraph(s) matched.\n\n` + JSON.stringify(results, null, 2) }] };
      }

      case 'edit_file': {
        const c    = getProject(args.projectName);
        const diff = await c.editFile(args.filePath, args.edits, args.dryRun ?? false, args.commitMessage, args.context ?? 1);
        return { content: [{ type: 'text', text: diff }] };
      }
      case 'read_lines': {
        const c = getProject(args.projectName);
        const { lines, from, to, total } = await c.readLines(args.filePath, args.start, args.end);
        const numbered = lines.map((line, i) => `${from + i}: ${line}`).join('\n');
        return { content: [{ type: 'text', text: `Lines ${from}-${to} of ${total}:\n${numbered}` }] };
      }

      case 'find_in_file': {
        const c       = getProject(args.projectName);
        const results = await c.findInFile(args.filePath, args.text, {
          caseSensitive: args.caseSensitive ?? false,
          context:       args.context ?? 0,
        });
        let text;
        if (results.length === 0) {
          text = 'No matches found';
        } else if ((args.context ?? 0) > 0) {
          text = results.map(r => {
            const ctxLines = r.contextLines.map(l => `${l.isMatch ? '>' : ' '} ${l.line}: ${l.text}`).join('\n');
            const range = r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`;
            return `Match at ${range}:\n${ctxLines}`;
          }).join('\n\n');
        } else {
          text = results.map(r => {
            const range = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
            return `${range}: ${r.matchText}`;
          }).join('\n');
        }
        return { content: [{ type: 'text', text }] };
      }

      case 'replace_lines': {
        const c      = getProject(args.projectName);
        const result = await c.replaceLines(args.filePath, args.start, args.end, args.content, args.commitMessage);
        return { content: [{ type: 'text', text: `Replaced ${result.replacedLines} lines with ${result.newLines} lines. File now has ${result.total} lines.` }] };
      }

      case 'insert_lines': {
        const c      = getProject(args.projectName);
        const result = await c.insertLines(args.filePath, args.after_line, args.content, args.commitMessage);
        return { content: [{ type: 'text', text: `Inserted ${result.insertedLines} lines after line ${args.after_line}. File now has ${result.total} lines.` }] };
      }

      case 'delete_lines': {
        const c      = getProject(args.projectName);
        const result = await c.deleteLines(args.filePath, args.start, args.end, args.commitMessage);
        return { content: [{ type: 'text', text: `Deleted ${result.deletedLines} lines. File now has ${result.total} lines.` }] };
      }

      case 'copy_lines': {
        const c      = getProject(args.projectName);
        const result = await c.copyLines(args.filePath, args.start, args.end, args.insertAfterLine, args.commitMessage);
        const startLine = result.insertedAfter + 1;
        const endLine   = result.insertedAfter + result.copiedLines;
        return { content: [{ type: 'text', text: `Copied ${result.copiedLines} lines. Inserted copy starts at line ${startLine}, ends at line ${endLine}. File now has ${result.total} lines.` }] };
      }

      case 'move_lines': {
        const c      = getProject(args.projectName);
        const result = await c.moveLines(args.filePath, args.start, args.end, args.insertAfterLine, args.commitMessage);
        const startLine = result.insertedAfter + 1;
        const endLine   = result.insertedAfter + result.movedLines;
        return { content: [{ type: 'text', text: `Moved ${result.movedLines} lines. Block now starts at line ${startLine}, ends at line ${endLine}. File now has ${result.total} lines.` }] };
      }

      case 'copy_lines_between_files': {
        const result = await copyLinesBetweenFiles(
          args.sourceProjectName, args.sourceFilePath, args.start, args.end,
          args.destProjectName, args.destFilePath, args.insertAfterLine, args.commitMessage
        );
        const startLine = result.insertedAfter + 1;
        const endLine   = result.insertedAfter + result.copiedLines;
        return { content: [{ type: 'text', text: `Copied ${result.copiedLines} lines from ${args.sourceFilePath} into ${args.destFilePath}. Inserted block starts at line ${startLine}, ends at line ${endLine}. ${args.destFilePath} now has ${result.destTotal} lines.` }] };
      }

      case 'move_lines_between_files': {
        const result = await moveLinesBetweenFiles(
          args.sourceProjectName, args.sourceFilePath, args.start, args.end,
          args.destProjectName, args.destFilePath, args.insertAfterLine, args.commitMessage
        );
        const startLine = result.insertedAfter + 1;
        const endLine   = result.insertedAfter + result.movedLines;
        return { content: [{ type: 'text', text: `Moved ${result.movedLines} lines from ${args.sourceFilePath} into ${args.destFilePath}. Inserted block starts at line ${startLine}, ends at line ${endLine}. ${args.destFilePath} now has ${result.destTotal} lines; ${args.sourceFilePath} now has ${result.sourceTotal} lines.` }] };
      }


      case 'append_to_file': {
        const c = getProject(args.projectName);
        await c.appendToFile(args.filePath, args.content, args.commitMessage);
        return { content: [{ type: 'text', text: `Successfully appended to ${args.filePath}` }] };
      }

      case 'find_in_files': {
        const c       = getProject(args.projectName);
        const results = await c.findInFiles(args.dirPath || '', args.text, {
          caseSensitive:   args.caseSensitive ?? false,
          filePattern:     args.filePattern || null,
          excludePatterns: args.excludePatterns || [],
        });
        const text = results.length > 0
          ? results.map(r => {
              const range = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
              return `${r.file}:${range}: ${r.matchText}`;
            }).join('\n')
          : 'No matches found';
        return { content: [{ type: 'text', text }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Overleaf MCP server running on stdio');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
