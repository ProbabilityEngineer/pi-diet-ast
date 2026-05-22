# pi-ast-lite

Lightweight pi extension for structural code search and replacement with ast-grep.

Tools:

- `ast_grep_search`
- `ast_grep_replace`

Includes a short prompt guideline nudging agents to use AST search for structural code questions before broad grep/find.

## Install

```bash
pi install git:github.com/ProbabilityEngineer/pi-ast-lite
```

For local testing:

```bash
pi -e ./index.ts
```

## Runtime

Uses `sg` from `@ast-grep/cli` if available, otherwise falls back to:

```bash
npx --yes @ast-grep/cli
```
