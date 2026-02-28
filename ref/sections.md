# Sections — Overleaf MCP ref

## Heading levels
```
\section{}           level 1
  \subsection{}      level 2
    \subsubsection{} level 3
      \paragraph{}   level 4
```
`sectionType` enum: `"section"` · `"subsection"` · `"subsubsection"` · `"paragraph"`

A block ends at the next heading of equal or higher level (lower number).

## Tools
| Tool | Required | Optional |
|---|---|---|
| `get_sections` | `filePath` | `sectionType`, `projectName` |
| `get_section_content` | `filePath`, `sectionTitle` | `sectionType`, `projectName` |
| `write_section` | `filePath`, `sectionTitle`, `newContent` | `sectionType`, `commitMessage`, `projectName` |
| `move_section` | `filePath`, `sourceTitle`, `anchorTitle`, `position` | `sectionType`, `commitMessage`, `projectName` |
| `insert_section` | `filePath`, `anchorTitle`, `newContent`, `position` | `anchorType`, `commitMessage`, `projectName` |

`position` enum: `"before"` · `"after"`

## Workflows

**Edit a section**
1. `get_section_content filePath sectionTitle [sectionType]`
2. Edit
3. `write_section filePath sectionTitle newContent [sectionType]`

**Reorder blocks**
```
move_section sourceTitle:"B" anchorTitle:"A" position:"before" sectionType:"subsection"
```
`sectionType` applies to both source and anchor. Source ≠ anchor.

**Add a new block**
```
insert_section anchorTitle:"Existing" newContent:"\subsection{New}\nText." position:"after"
```
Include the heading command in `newContent` if creating a named block.

## Rules
- `get_sections` hides `\paragraph{}` by default — pass `sectionType:"paragraph"` to include them
- `write_section` and `insert_section`: `newContent` must include the opening heading line
- Starred headings (`\section*{...}`) are matched correctly
- Do not wrap long lines in LaTeX content
