# Preamble — Overleaf MCP ref

## Tools
| Tool | Required | Optional |
|---|---|---|
| `get_preamble` | `filePath` | `projectName` |
| `write_preamble` | `filePath`, `newPreamble` | `commitMessage`, `projectName` |

## Workflow
1. `get_preamble filePath:"main.tex"` — returns everything before `\begin{document}`
2. Edit the string (packages, `\documentclass`, custom commands, etc.)
3. `write_preamble filePath:"main.tex" newPreamble:"..."`

## Rules
- `newPreamble` must NOT include `\begin{document}` — the document body is preserved exactly
- Only works on root `.tex` files that contain `\begin{document}` — throws otherwise
