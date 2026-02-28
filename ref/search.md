# Paragraph Search — Overleaf MCP ref

## Tool
| Tool | Required | Optional |
|---|---|---|
| `search_paragraphs` | `filePath`, `keywords` | `matchAll`, `sectionTitle`, `sectionType`, `projectName` |

## Workflow
1. `search_paragraphs filePath keywords:["term1","term2"]`
2. Use `location` breadcrumb from results → `get_section_content` (see `ref/sections.md`)
3. `write_section`

## Result shape
```json
{
  "matchedKeywords": ["term1"],
  "location": { "section": "Introduction", "subsection": "Background" },
  "text": "paragraph text..."
}
```

## Notes
- Match logic: `matchAll:false` (default) = OR; `matchAll:true` = AND (all keywords required)
- Scope to a section: `sectionTitle:"Introduction" sectionType:"section"`
- Each paragraph returned at most once
- Splits on blank lines; heading lines are excluded from results
