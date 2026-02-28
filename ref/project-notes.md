# Project Notes — Overleaf MCP ref

When working in a project that has a `NOTES.md` file at the root, load it first.
It contains project-specific context that avoids redundant discovery calls.

## What NOTES.md contains (and how to use it)

| Section | Why it saves tokens |
|---|---|
| File map | Tells you which `.tex` file covers what — no need to `list_files` + guess |
| Active / stale files | Prevents accidentally editing deprecated drafts |
| Bib files | Which `.bib` files exist and what they cover |
| Custom commands | Summary of `\newcommand` — no need to re-read the preamble |
| Label conventions | Prefix rules (`fig:`, `tab:`, `eq:`, `sec:`) and citation key format |
| Open TODOs | Where work was left off |
| Quirks | Anything non-standard about compilation or structure |

## Keeping it current
Update `NOTES.md` (via `write_file` or `create_file`) whenever:
- A new `.tex` or `.bib` file is added or removed
- A section is moved to a different file
- A new `\newcommand` is defined in the preamble
- A file becomes stale / deprecated

---

## Template — copy into your project as `NOTES.md`

See `NOTES_TEMPLATE.md` in the MCP folder for the starter template.
