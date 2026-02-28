# Paragraph naming & dedup — Overleaf MCP ref

## Convention
All searchable atomic blocks use `\paragraph{Descriptive Name}`.
Names should be unique within a file so `search_paragraphs` returns unambiguous results.

**Good names** describe what the block *is*, not where it sits:
```latex
\paragraph{Main convergence result}
\paragraph{Ablation: learning rate}
\paragraph{Limitation: small datasets}
```

**Avoid** generic names like `\paragraph{Note}` or `\paragraph{Result}` — these will collide and get auto-numbered.

---

## Checking & fixing duplicates

### Preview (dry run — no write)
```
dedup_paragraphs filePath:"sections/results.tex" dryRun:true
```
Returns `{ renamed: [{from, to}], dryRun: true, message }`.

### Apply fix
```
dedup_paragraphs filePath:"sections/results.tex"
```
First occurrence keeps its name. Later ones get ` 2`, ` 3`, etc.:
```
\paragraph{Result}     → unchanged
\paragraph{Result}     → \paragraph{Result 2}
\paragraph{Result}     → \paragraph{Result 3}
```
Works on both `\paragraph{}` and `\paragraph*{}`.

---

## When to run
- After pasting in a block from another file
- After a large restructure
- Any time `search_paragraphs` returns more results than expected
