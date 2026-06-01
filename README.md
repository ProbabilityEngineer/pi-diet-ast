# pi-diet-ast

Lightweight pi extension for structural code search and replacement with ast-grep.

Tools:

- `ast_grep_search`
- `ast_grep_replace`

Includes short prompt guidance nudging agents to use AST search for structural code questions before broad grep/find.

## Search ergonomics

`ast_grep_search` supports two styles:

1. Custom ast-grep pattern:

```json
{ "mode": "pattern", "pattern": "foo($$$ARGS)", "lang": "typescript", "paths": ["index.ts"] }
```

2. Compact presets for common structural searches:

```json
{ "mode": "calls", "name": "runJj", "lang": "typescript", "paths": ["index.ts"] }
{ "mode": "imports", "module": "node:child_process", "lang": "typescript", "paths": ["index.ts"] }
{ "mode": "functions", "name": "buildStatus", "lang": "typescript", "paths": ["index.ts"] }
{ "mode": "classes", "name": "Parser", "lang": "typescript", "paths": ["src"] }
{ "mode": "exports", "lang": "typescript", "paths": ["index.ts"] }
```

Presets keep the tool count small while avoiding hand-written ast-grep patterns for frequent tasks. `mode` defaults to `pattern` for compatibility. For `mode: "calls"`, a bare name such as `registerCommand` matches both bare calls and member calls like `pi.registerCommand(...)`; use a dotted name for an exact callee.

## Replace

`ast_grep_replace` remains conservative: it is a dry run unless `apply: true` is passed.

```json
{
  "pattern": "foo($$$ARGS)",
  "rewrite": "bar($$$ARGS)",
  "lang": "typescript",
  "paths": ["src"],
  "apply": false
}
```

## Install

```bash
pi install git:github.com/ProbabilityEngineer/pi-diet-ast
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
