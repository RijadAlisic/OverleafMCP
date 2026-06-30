# Overleaf MCP — Reference Index (v1.10)

Start server: `node /home/%USER%/OverleafMCP/overleaf-mcp-server.js`
Projects: `projects.json` — omit `projectName` to use `"default"`.

**If the project has a `NOTES.md` at its root, load it first.**

## Load the right file for your task

| Task | Load |
|---|---|
| List, read, create, delete files | `ref/files.md` |
| Read/edit preamble | `ref/preamble.md` |
| Read/edit/move/insert sections | `ref/sections.md` |
| Paragraph naming convention + dedup | `ref/paragraphs.md` |
| Search LaTeX paragraphs | `ref/search.md` |
| Read/search/edit `.bib` entries | `ref/bibtex.md` |
| Line-level edits, reorganising within/between files | `ref/lines.md` |
| Project-level notes convention | `ref/project-notes.md` |
| Adding or modifying tools | `ref/dev.md` |

## Avoiding overwrites

`create_file` never overwrites — a path collision auto-redirects to an incremented filename instead (see `ref/files.md`). To merge content into an existing file without rewriting it, use the line-reorganisation tools in `ref/lines.md`.
