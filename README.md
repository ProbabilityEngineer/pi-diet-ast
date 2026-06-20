# pi-diet-ast

> One of my diet context engineering and workflow extensions. Add pi-diet-LSP, pi-diet-Ripgrep, pi-repo-move and others from [npm](https://www.npmjs.com/~probabilityengineer).

On-demand ast-grep structural search and replacement tools for Pi.

`pi-diet-ast` gives Pi agents a compact pair of model-visible tools for syntax-aware code search and conservative structural replacement. It keeps the prompt surface small: one search tool, one replace tool, no automatic scans, and no dynamic context injection.

Use it when a request is shaped like code structure — calls, imports, functions, classes, exports, object patterns, decorators, control flow — where `grep` is too literal and semantic search is too broad.

## Tools

- `ast_grep_search` — AST-aware code search
- `ast_grep_replace` — AST-aware replacement, dry-run by default

## Search ergonomics

`ast_grep_search` supports two styles.

### Custom ast-grep pattern

```json
{ "mode": "pattern", "pattern": "foo($$$ARGS)", "lang": "typescript", "paths": ["index.ts"] }
```

### Compact presets

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

From npm:

```bash
pi install npm:pi-diet-ast
```

From GitHub:

```bash
pi install git:github.com/ProbabilityEngineer/pi-diet-ast
```

For project-local install, add `-l`:

```bash
pi install -l npm:pi-diet-ast
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

## Prompt overhead

`pi-diet-ast` registers compact tools and routing guidance only. It does not inject scan results or repository state into prompts.
