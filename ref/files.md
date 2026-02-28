# Files — Overleaf MCP ref

## Tools
| Tool | Required | Optional |
|---|---|---|
| `list_projects` | — | — |
| `list_files` | — | `extension` (default `.tex`; use `.bib` for bib files), `projectName` |
| `read_file` | `filePath` | `projectName` |
| `status_summary` | — | `projectName` |
| `create_file` | `filePath` | `content`, `commitMessage`, `projectName` |
| `copy_file` | `srcPath`, `destPath` | `commitMessage`, `projectName` |
| `delete_file` | `filePath` | `commitMessage`, `projectName` |

## Notes
- All `filePath` values are relative to the project root
- `create_file` does `mkdir -p` — safe to use with subdirectory paths
- `delete_file` uses `git rm` + push
- Every write auto-pulls before writing — no manual sync needed
- `status_summary` returns file count, main file, and heading counts (sections/subsections/etc.)
