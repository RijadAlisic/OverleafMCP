# Developer Guide — Overleaf MCP ref

## Adding a new tool

1. Add a method to `OverleafGitClient` in `overleaf-mcp-server.js`
2. Add an entry to the `tools` array in the `ListToolsRequestSchema` handler
3. Add a `case` in the `CallToolRequestSchema` switch
4. Bump the version string in `new Server({ name, version })`
5. Update `CLAUDE_REFERENCE.md` index table + add or update the relevant `ref/*.md` file

## Architecture
```
overleaf-mcp-server.js
  ├── OverleafGitClient class  ← all git + file + parse logic
  └── MCP server layer         ← tool definitions + request routing

projects.json  ← { projects: { default: { projectId, gitToken, name } } }
Temp repo:     /tmp/overleaf-<projectId>/
```

## OverleafGitClient internal methods
| Method | Purpose |
|---|---|
| `cloneOrPull()` | Ensures local repo is up-to-date before any operation |
| `readRaw(filePath)` | Read file (pulls first) |
| `writeRaw(filePath, content, msg)` | Write + `git add` + `git commit` + `git push` |
| `_beginDocIndex(content)` | Finds `\begin{document}` offset; throws if absent |
| `_parseHeadings(content)` | Returns `[{title, type, level, index}]` |
| `_headingBounds(content, title, type?)` | Returns `[start, end]` char indices |
| `_parseParagraphs(slice, baseOffset)` | Splits on blank lines, skips heading lines |
| `_buildLocationIndex(content)` | Returns `(pos, type) → heading title` closure |
| `_parseBibEntries(content)` | Returns `[{key, type, fields, rawText, start, end}]` |

## Common pitfalls
- `write_preamble` throws if file has no `\begin{document}` — not safe for included files
- `move_section`: `sectionType` applies to both source and anchor
- BibTeX `write_bib_entry`: replacement is character-range based — `newEntryText` must be valid BibTeX
