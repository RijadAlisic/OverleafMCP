#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
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
    await exec(
      `cd "${this.repoPath}" && git add "${filePath}" && git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    const { stdout } = await exec(
      `cd "${this.repoPath}" && git push "${this.gitUrlWithAuth}"`,
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    return stdout;
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
    const pushed = await this.commitAndPush(filePath, commitMessage);
    return `"${filePath}" written and pushed.\n${pushed}`;
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
      headings.push({
        title: m[2],
        type:  m[1],
        level: SECTION_LEVELS[m[1]],
        index: m.index,
      });
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

  async searchBibEntries(filePath, query, field = null) {
    const content = await this.readRaw(filePath);
    const entries = this._parseBibEntries(content);
    const q = query.toLowerCase();
    return entries.filter(e => {
      if (field) {
        const f = (e.fields[field.toLowerCase()] || '').toLowerCase();
        return f.includes(q);
      }
      // Search key + all field values
      if (e.key.toLowerCase().includes(q)) return true;
      return Object.values(e.fields).some(v => v.toLowerCase().includes(q));
    }).map(e => ({ key: e.key, type: e.type, fields: e.fields, rawText: e.rawText }));
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

  async createFile(filePath, content = '', commitMessage = 'Create file via MCP') {
    return this.writeRaw(filePath, content, commitMessage);
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

// ── MCP server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'overleaf-mcp-server', version: '1.10.0' },
  { capabilities: { tools: {} } }
);

function getProject(projectName = 'default') {
  const project = projectsConfig.projects[projectName];
  if (!project) throw new Error(`Project "${projectName}" not found in configuration`);
  return new OverleafGitClient(project.projectId, project.gitToken);
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
      description: 'Create a new file in the project and push it to Overleaf',
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
      description: 'Search BibTeX entries in a .bib file by any field value or citation key (case-insensitive, partial match). Optionally scope to a specific field (e.g. "title", "author").',
      inputSchema: {
        type: 'object',
        properties: {
          filePath:    filePathProp,
          query:       { type: 'string', description: 'Search string (partial match, case-insensitive)' },
          field:       { type: 'string', description: 'Limit search to this field name, e.g. "title" or "author" (optional)' },
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
        return { content: [{ type: 'text', text: await c.createFile(args.filePath, args.content || '', args.commitMessage || `Create ${args.filePath} via MCP`) }] };
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
        return { content: [{ type: 'text', text: await c.writeSection(args.filePath, args.sectionTitle, args.newContent, args.sectionType || null, args.commitMessage) }] };
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
        const results = await c.searchBibEntries(args.filePath, args.query, args.field || null);
        return { content: [{ type: 'text', text: `${results.length} entry/entries matched.

` + JSON.stringify(results, null, 2) }] };
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

      case 'search_paragraphs': {
        const c       = getProject(args.projectName);
        const results = await c.searchParagraphs(args.filePath, args.keywords, args.matchAll ?? false, args.sectionTitle || null, args.sectionType || null);
        return { content: [{ type: 'text', text: `${results.length} paragraph(s) matched.\n\n` + JSON.stringify(results, null, 2) }] };
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
