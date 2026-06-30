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
- `create_file` **never overwrites** an existing file. If `filePath` already exists, the content is saved instead to an incremented filename (`name (1).tex`, `name (2).tex`, ...) and the response is flagged as an error (`isError: true`) naming both paths. To merge the content into the original file, use the line-reorganisation tools in `ref/lines.md` (`copy_lines_between_files` / `move_lines_between_files` / `append_to_file`), then delete the redirected file once merged.
- `delete_file` uses `git rm` + push
- Every write auto-pulls before writing — no manual sync needed
- `status_summary` returns file count, main file, and heading counts (sections/subsections/etc.)

