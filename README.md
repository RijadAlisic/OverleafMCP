# Overleaf MCP Server

*Originally forked from [mjyoo2](https://github.com/mjyoo2)*

An MCP (Model Context Protocol) server that provides full read/write access to Overleaf projects via Git integration. Allows Claude and other MCP clients to read LaTeX files, analyse document structure, edit content, manage preambles, reorganise sections, and manage bibliography entries directly within your Overleaf projects.

## Features

- 📄 **File Management**: Create, read, copy, delete, and list files across your Overleaf projects.
- ✍️ **Surgical Editing**: Read and write specific sections, subsections, and paragraphs without touching the rest of the document.
- 🏗️ **Structural Control**: Move and insert sections or paragraphs to reorganise your paper atomically.
- ⚙️ **Preamble Management**: Isolate and edit document setup (packages, custom commands) safely.
- 📚 **BibTeX Management**: Search entries by any field, retrieve by citation key, and replace individual entries in-place.
- 🔍 **Semantic Search**: Search paragraphs by keywords to quickly find and edit relevant content.
- 🔁 **Paragraph Deduplication**: Automatically detect and rename duplicate `\paragraph{}` names.
- 📊 **Project Summary**: Get an overview of project status and structure.
- 🔄 **Auto-Sync**: Every write operation automatically pulls the latest state and pushes changes immediately to Overleaf.

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```
3. Set up your projects configuration:
```bash
cp projects.example.json projects.json
```
4. Edit `projects.json` with your Overleaf credentials:
```json
{
  "projects": {
    "default": {
      "name": "My Paper",
      "projectId": "YOUR_OVERLEAF_PROJECT_ID",
      "gitToken": "YOUR_OVERLEAF_GIT_TOKEN"
    }
  }
}
```

## Getting Overleaf Credentials

1. **Git Token**: Go to Overleaf Account Settings → Git Integration → Create Token
2. **Project ID**: Open your project — it's in the URL: `https://www.overleaf.com/project/[PROJECT_ID]`

## Claude Desktop Setup

Add to your Claude Desktop config:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/OverleafMCP/overleaf-mcp-server.js"]
    }
  }
}
```

Restart Claude Desktop after configuration.

## Available Tools

### File Management
| Tool | Description |
|---|---|
| `list_projects` | List all configured projects |
| `status_summary` | Project overview: file count and heading breakdown |
| `list_files` | List files (optional `extension`, default `.tex`; use `.bib` for bib files) |
| `read_file` | Read a file's full contents |
| `create_file` | Create a new file |
| `copy_file` | Copy a file server-side (no content passes through the agent) |
| `delete_file` | Delete a file via `git rm` |

### Preamble
| Tool | Description |
|---|---|
| `get_preamble` | Read everything before `\begin{document}` |
| `write_preamble` | Replace the preamble — body is preserved exactly. Must NOT include `\begin{document}`. |

### Sections & Paragraphs
| Tool | Description |
|---|---|
| `get_sections` | List headings (optional `sectionType` filter) |
| `get_section_content` | Read a named heading block |
| `write_section` | Replace a heading block in-place. `newContent` must include the heading line. |
| `move_section` | Atomically cut and splice a block before/after another |
| `insert_section` | Insert a new block before/after a named heading |
| `dedup_paragraphs` | Find and rename duplicate `\paragraph{}` names (supports `dryRun`) |

### BibTeX
| Tool | Description |
|---|---|
| `search_bib_entries` | Partial case-insensitive search across all fields or scoped to one (e.g. `field:"title"`) |
| `get_bib_entry` | Retrieve a single entry by citation key |
| `write_bib_entry` | Replace a single entry in-place — nothing else in the file is touched |

### Search
| Tool | Description |
|---|---|
| `search_paragraphs` | Search paragraphs by keywords; returns matches with section breadcrumb. `matchAll:true` for AND logic. |

*All tools accept an optional `projectName` argument. Omit to use `"default"`.*

## Heading Hierarchy

```
\section{}           level 1  ("section")
  \subsection{}      level 2  ("subsection")
    \subsubsection{} level 3  ("subsubsection")
      \paragraph{}   level 4  ("paragraph")
```

Starred headings (`\section*{...}`) are matched correctly. A block ends at the next heading of equal or higher level.

## Paragraph naming convention

Use `\paragraph{Descriptive Name}` for all atomic searchable blocks. Names should be unique within a file — run `dedup_paragraphs` after any restructure or paste. The tool keeps the first occurrence and appends ` 2`, ` 3`, … to duplicates.

## Agent reference files

The `ref/` folder contains focused reference files for Claude to load on demand — one per topic — rather than reading everything at once:

| File | Topic |
|---|---|
| `CLAUDE_REFERENCE.md` | Index — load this first |
| `ref/files.md` | File tools |
| `ref/preamble.md` | Preamble tools |
| `ref/sections.md` | Section/paragraph tools |
| `ref/paragraphs.md` | Paragraph naming & dedup |
| `ref/search.md` | Paragraph search |
| `ref/bibtex.md` | BibTeX tools |
| `ref/project-notes.md` | Project-level NOTES.md convention |
| `ref/dev.md` | Adding/modifying tools |

A `NOTES_TEMPLATE.md` is also included — copy it into your Overleaf project as `NOTES.md` and keep it updated so agents can orient themselves without rediscovering the structure each session.

## Multi-Project Usage

```json
{
  "projects": {
    "default": { "name": "Main Paper", "projectId": "id-1", "gitToken": "token-1" },
    "paper2":  { "name": "Second Paper", "projectId": "id-2", "gitToken": "token-2" }
  }
}
```

Then pass `projectName:"paper2"` to any tool.

## Important Notes

- All `filePath` values are relative to the project root
- Every write pulls latest state before writing — no manual sync needed
- Do not wrap long lines in LaTeX content — one paragraph per line
- `projects.json` is gitignored — never commit real credentials

## Security

- `projects.json` is gitignored to protect your credentials
- Use `projects.example.json` as a template

## License

MIT License
