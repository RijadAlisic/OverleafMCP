# BibTeX — Overleaf MCP ref

## Tools
| Tool | Required | Optional |
|---|---|---|
| `search_bib_entries` | `filePath`, `query` | `field` (e.g. `"title"`, `"author"`), `projectName` |
| `get_bib_entry` | `filePath`, `key` | `projectName` |
| `write_bib_entry` | `filePath`, `key`, `newEntryText` | `commitMessage`, `projectName` |

To list `.bib` files: use `list_files` with `extension: ".bib"` (see `ref/files.md`).

## Workflow
1. `search_bib_entries filePath:"refs.bib" query:"neural network"` — partial, case-insensitive; searches all fields + citation key
2. Find the `key` from results
3. `write_bib_entry filePath key newEntryText` — replaces only that entry, pushes

**Scope search to one field:**
```
search_bib_entries filePath:"refs.bib" query:"Smith" field:"author"
```

**Fetch by exact key:**
```
get_bib_entry filePath:"refs.bib" key:"smith2020"
```

## Notes
- `search_bib_entries` returns `[{ key, type, fields, rawText }]`
- `write_bib_entry`: `newEntryText` must be the full entry including `@type{key, ...}`
- Only the targeted entry's character range is replaced — nothing else in the file changes
- Nested braces in field values are handled correctly
