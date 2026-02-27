# Overleaf MCP — Claude Quick Reference (v1.7)

## Starting the server
```
node /home/rijad/OverleafMCP/overleaf-mcp-server.js
```

## Project config
Projects are in `projects.json`. Omit `projectName` to use `"default"`.

---

## Heading hierarchy (4 levels)

```
\section{Title}           ← level 1
  \subsection{Title}      ← level 2
    \subsubsection{Title} ← level 3
      \paragraph{Title}   ← level 4
```

All four levels are handled by the same tools via `sectionType`.

---

## Tool index

### File-level
| Tool | Required | Optional |
|---|---|---|
| `list_projects` | — | — |
| `list_files` | — | `extension`, `projectName` |
| `read_file` | `filePath` | `projectName` |
| `status_summary` | — | `projectName` |
| `create_file` | `filePath` | `content`, `commitMessage`, `projectName` |
| `delete_file` | `filePath` | `commitMessage`, `projectName` |

### Preamble
| Tool | Required | Optional |
|---|---|---|
| `get_preamble` | `filePath` | `projectName` |
| `write_preamble` | `filePath`, `newPreamble` | `commitMessage`, `projectName` |

### Section / paragraph — read & write
| Tool | Required | Optional |
|---|---|---|
| `get_sections` | `filePath` | `sectionType`, `projectName` |
| `get_section_content` | `filePath`, `sectionTitle` | `sectionType`, `projectName` |
| `write_section` | `filePath`, `sectionTitle`, `newContent` | `sectionType`, `commitMessage`, `projectName` |

### Section / paragraph — structural
| Tool | Required | Optional |
|---|---|---|
| `move_section` | `filePath`, `sourceTitle`, `anchorTitle`, `position` | `sectionType`, `commitMessage`, `projectName` |
| `insert_section` | `filePath`, `anchorTitle`, `newContent`, `position` | `anchorType`, `commitMessage`, `projectName` |

### Search
| Tool | Required | Optional |
|---|---|---|
| `search_paragraphs` | `filePath`, `keywords` | `matchAll`, `sectionTitle`, `sectionType`, `projectName` |

---

## Key tool details

### Preamble tools
- `get_preamble` returns everything before `\begin{document}` — packages, `\documentclass`, custom commands, etc.
- `write_preamble`: `newPreamble` must NOT include `\begin{document}`. The document body is preserved exactly.
- Only works on root `.tex` files that contain `\begin{document}`.

### `sectionType` enum
`"section"` · `"subsection"` · `"subsubsection"` · `"paragraph"`
- `get_sections` hides `\paragraph{}` by default — pass `sectionType:"paragraph"` to see them
- `write_section`: `newContent` must include the opening heading line
- Boundary: block ends at the next heading of equal or higher level

### `move_section`
Cuts `sourceTitle` block and splices it before/after `anchorTitle` atomically. `sectionType` applies to both.

### `insert_section`
Inserts a brand-new block before/after `anchorTitle`. Include the heading command in `newContent` if creating a named block.

### `search_paragraphs`
Returns `[{ matchedKeywords, location, text }]` — each paragraph at most once.
- `location` breadcrumb tells you the enclosing section/subsection/etc.
- `matchAll:true` = AND; default = OR

---

## Canonical workflows

### Inspect / edit the preamble
1. `get_preamble filePath:"main.tex"` → read packages and settings
2. Edit the string
3. `write_preamble filePath:"main.tex" newPreamble:"..."`

### Edit a section / paragraph
1. `get_section_content filePath sectionTitle [sectionType]`
2. Edit
3. `write_section filePath sectionTitle newContent [sectionType]`

### Reorder two blocks
```
move_section sourceTitle:"B" anchorTitle:"A" position:"before" sectionType:"paragraph"
```

### Add a new paragraph
```
insert_section anchorTitle:"Existing" newContent:"\paragraph{New}\nText." position:"after" anchorType:"paragraph"
```

### Find content by topic, then edit
1. `search_paragraphs keywords:["term1","term2"]`
2. Use `location` → `get_section_content`
3. `write_section`

---

## Notes
- All `filePath` values are relative to the project root
- Every write pulls latest state before writing — no manual sync needed
- Changes appear in Overleaf immediately after push
- Do not wrap long lines when writing LaTeX — one paragraph per line
- Starred headings (`\section*{...}`) are matched correctly
