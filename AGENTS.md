# Agent Instructions

## Repository

- `pi-diet-ast` is a TypeScript Pi extension exposing on-demand ast-grep structural search and replacement tools.
- The extension entry point is `index.ts`; keep structural operations explicit and deterministic.

## Validation

- Run `npm run lint` and `npm run build` after implementation changes.
- Test replacements against focused fixtures and preserve dry-run behavior unless an explicit apply operation is requested.

## Version control

- Use normal Git workflows. Inspect `git status` and the diff before committing or pushing.
