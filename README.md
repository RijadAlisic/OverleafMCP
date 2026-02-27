# Overleaf MCP Server

*Originally forked from [mjyoo2](https://github.com/mjyoo2)*

An MCP (Model Context Protocol) server that provides full read/write access to Overleaf projects via Git integration. This allows Claude and other MCP clients to read LaTeX files, analyze document structure, edit content, manage preambles, and reorganize sections directly within your Overleaf projects.

## Features

- 📄 **File Management**: Create, read, delete, and list files across your Overleaf projects.
- ✍️ **Surgical Editing**: Read and write specific sections, subsections, and paragraphs without touching the rest of the document.
- 🏗️ **Structural Control**: Move and insert sections or paragraphs to reorganize your paper atomically.
- ⚙️ **Preamble Management**: Isolate and edit document setup (packages, custom commands) safely.
- 🔍 **Semantic Search**: Search paragraphs by keywords to quickly find and edit relevant topics.
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

1. **Git Token**:
* Go to Overleaf Account Settings → Git Integration
* Click "Create Token"


2. **Project ID**:
* Open your Overleaf project
* Find it in the URL: `https://www.overleaf.com/project/[PROJECT_ID]`



## Claude Desktop Setup

Add to your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": [
        "/absolute/path/to/OverleafMCP/overleaf-mcp-server.js"
      ]
    }
  }
}

```

Restart Claude Desktop after configuration.

## Heading Hierarchy

The server understands 4 levels of LaTeX document hierarchy via the `sectionType` argument:

1. `\section{...}` (`"section"`)
2. `\subsection{...}` (`"subsection"`)
3. `\subsubsection{...}` (`"subsubsection"`)
4. `\paragraph{...}` (`"paragraph"`)

*Note: Starred headings (e.g., \section*{...}) are matched correctly.*

## Available Tools

### File Management

* **`list_projects`**: List all configured projects.
* **`status_summary`**: Get a comprehensive project status summary.
* **`list_files`**: List files in a project (Optional: `extension`).
* **`read_file`**: Read a specific file (Required: `filePath`).
* **`create_file`**: Create a new file (Required: `filePath`; Optional: `content`, `commitMessage`).
* **`delete_file`**: Delete a file (Required: `filePath`; Optional: `commitMessage`).

### Preamble Management

*Only works on root `.tex` files containing \begin{document}.*

* **`get_preamble`**: Returns everything before \begin{document} (packages, document class, commands).
* **`write_preamble`**: Overwrites the preamble. *Note: The new preamble must NOT include \begin{document}; the document body is preserved exactly.*

### Section / Paragraph (Read & Write)

* **`get_sections`**: Get all sections from a LaTeX file. (Optional: `sectionType` to change granularity).
* **`get_section_content`**: Get the content of a specific section (Required: `filePath`, `sectionTitle`).
* **`write_section`**: Overwrite a specific section block. *Note: `newContent` must include the opening heading line.*

### Section / Paragraph (Structural)

* **`move_section`**: Cuts a `sourceTitle` block and splices it before or after an `anchorTitle` atomically. (Required: `filePath`, `sourceTitle`, `anchorTitle`, `position`).
* **`insert_section`**: Inserts a brand-new block before or after an `anchorTitle`. (Required: `filePath`, `anchorTitle`, `newContent`, `position`).

### Search

* **`search_paragraphs`**: Returns matching paragraphs and their breadcrumb location in the document hierarchy. (Required: `filePath`, `keywords`; Optional: `matchAll` for AND logic, default is OR).

*(Note: All tools accept an optional `projectName` argument to target a specific project from your `projects.json`. If omitted, it defaults to `"default"`.)*

## Canonical Workflows

### Inspect & Edit the Preamble

1. Use `get_preamble` with `filePath:"main.tex"`
2. Edit the returned string locally
3. Use `write_preamble` with `filePath:"main.tex"` and `newPreamble:"..."`

### Edit a Specific Section

1. Use `get_section_content` with `filePath:"main.tex"`, `sectionTitle:"Methodology"`
2. Make your edits
3. Use `write_section` with `filePath:"main.tex"`, `sectionTitle:"Methodology"`, `newContent:"..."`

### Reorder Document Structure

Use `move_section` with:

* `sourceTitle`: "Secondary Findings"
* `anchorTitle`: "Primary Findings"
* `position`: "after"
* `sectionType`: "subsection"

## Important Notes & Best Practices

* **Relative Paths**: All `filePath` values are relative to the project root.
* **Immediate Syncing**: Every write operation pulls the latest state before writing—no manual sync needed. Changes appear in Overleaf immediately after the tool runs.
* **Formatting**: When writing LaTeX via the tools, do not wrap long lines manually; maintain one paragraph per line for optimal Overleaf compatibility.

## Multi-Project Usage

To work with multiple projects, add them to `projects.json`:

```json
{
  "projects": {
    "default": {
      "name": "Main Paper",
      "projectId": "project-id-1",
      "gitToken": "token-1"
    },
    "paper2": {
      "name": "Second Paper", 
      "projectId": "project-id-2",
      "gitToken": "token-2"
    }
  }
}

```

Then specify the project in tool calls:
Use `get_section_content` with `projectName: "paper2"`, `filePath: "main.tex"`, `sectionTitle: "Methods"`

## Security Notes

* `projects.json` is gitignored to protect your credentials.
* Never commit real project IDs or Git tokens.
* Use the provided `projects.example.json` as a template.

## License

MIT License

