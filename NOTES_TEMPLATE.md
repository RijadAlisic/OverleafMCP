# Project Notes
<!-- Keep this file updated. An agent reads it at the start of each session to avoid rediscovering the project. -->

## File map
<!-- Which file covers what. Be specific enough to navigate without listing files. -->
| File | Contents |
|---|---|
| `main.tex` | Root file — includes all others, nothing else |
| `sections/intro.tex` | Introduction |
| `sections/method.tex` | Method |
| `sections/results.tex` | Results and analysis |
| `sections/discussion.tex` | Discussion |
| `sections/conclusion.tex` | Conclusion |

## Stale / do-not-edit files
<!-- Files that exist but should not be touched -->
- (none yet)

## Bibliography
| File | Covers |
|---|---|
| `refs.bib` | All references |

**Citation key format:** `AuthorYEARkeyword` — e.g. `smith2021convergence`

## Custom commands
<!-- Summary of \newcommand definitions from the preamble -->
| Command | Expands to | Notes |
|---|---|---|
| `\R` | `\mathbb{R}` | Real numbers |
| `\todo{text}` | highlighted note | Remove before submission |

## Label conventions
| Type | Prefix | Example |
|---|---|---|
| Section | `sec:` | `\label{sec:method}` |
| Figure | `fig:` | `\label{fig:overview}` |
| Table | `tab:` | `\label{tab:results}` |
| Equation | `eq:` | `\label{eq:loss}` |

## Paragraph naming convention
- Use `\paragraph{Descriptive Name}` for all atomic searchable blocks
- Names must be unique within each file (run `dedup_paragraphs` after any restructure)
- Names describe *what* the block is, not its position: `\paragraph{Main convergence result}` not `\paragraph{Result 1}`

## Open TODOs
<!-- Updated as work progresses -->
- [ ] Fill in ablation study results
- [ ] Add Figure 3 and caption

## Quirks
<!-- Anything non-standard about this project -->
- Must compile with `pdflatex` (not `lualatex`) — uses package X which is incompatible
- `appendix.tex` is included conditionally — see preamble flag `\shoWappendix`
