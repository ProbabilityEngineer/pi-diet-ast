import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LANGS = ["bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html", "java", "javascript", "json", "kotlin", "lua", "nix", "php", "python", "ruby", "rust", "scala", "solidity", "swift", "tsx", "typescript", "yaml"] as const;
const SEARCH_MODES = ["pattern", "calls", "imports", "functions", "classes", "exports"] as const;
const MAX_OUTPUT = 60_000;
const AST_PROMPT_SNIPPET =
  "Tool routing: use ast_grep_search first for structural code-shape questions; use grep for literal text.";
const AST_GUIDELINES = [
  "Use ast_grep_search first for structural code-shape questions, including calls, imports, exports, functions/classes, object literals, decorators, catch blocks, and control flow, even when the target file is unknown.",
  "For calls/imports/functions/classes/exports, set mode plus name/module; use pattern only for custom AST shapes.",
  "Use Semble for conceptual behavior discovery, not syntax-shape searches; use grep only for exact literal text, strings, or identifiers.",
  "Use ast_grep_replace for structural edits; keep dry-run unless applying an intentional replacement.",
];

type RunResult = { code: number | null; stdout: string; stderr: string };
type ToolCtx = { cwd?: string };
type SearchMode = (typeof SEARCH_MODES)[number];
type SgMatch = {
  text?: string;
  lines?: string;
  file?: string;
  path?: string;
  range?: { start?: { line?: number; column?: number } };
};

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

async function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: cwd ?? process.cwd(), shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += String(data);
      if (stdout.length > MAX_OUTPUT) child.kill();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += String(data);
      if (stderr.length > MAX_OUTPUT) child.kill();
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sg(args: string[], cwd?: string) {
  let result = await run("sg", args, cwd);
  if (result.code === 127) {
    result = await run("npx", ["--yes", "@ast-grep/cli", ...args], cwd);
  }
  return result;
}

function parseSgJson(stdout: string): SgMatch[] {
  const raw = stdout.trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

function matchKey(match: SgMatch): string {
  const file = match.file ?? match.path ?? "?";
  const start = match.range?.start;
  return `${file}:${start?.line ?? "?"}:${start?.column ?? "?"}:${match.text ?? match.lines ?? ""}`;
}

function formatMatches(matches: SgMatch[], fallback = "No matches") {
  if (matches.length === 0) return fallback;
  return matches
    .slice(0, 100)
    .map((match) => {
      const file = match.file ?? match.path ?? "?";
      const start = match.range?.start;
      const line = typeof start?.line === "number" ? start.line + 1 : "?";
      const column = typeof start?.column === "number" ? start.column + 1 : "?";
      const body = String(match.text ?? match.lines ?? "").trim();
      return `${file}:${line}:${column}\n${body}`;
    })
    .join("\n\n---\n");
}

function formatSgJson(stdout: string, stderr: string) {
  const raw = stdout.trim();
  if (!raw) return stderr.trim() || "No matches";
  try {
    return formatMatches(parseSgJson(raw));
  } catch {
    return raw || stderr.trim();
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${name} is required for this ast_grep_search mode`);
}

function quote(value: string) {
  return JSON.stringify(value);
}

function tsLike(lang: string) {
  return ["javascript", "typescript", "tsx"].includes(lang);
}

function searchPatterns(params: any): { mode: SearchMode; patterns: string[] } {
  const mode = (params.mode ?? "pattern") as SearchMode;
  if (!SEARCH_MODES.includes(mode)) throw new Error(`Unsupported ast_grep_search mode: ${mode}`);
  if (mode === "pattern") return { mode, patterns: [requireString(params.pattern, "pattern")] };

  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
  const module = typeof params.module === "string" && params.module.trim() ? params.module.trim() : undefined;

  if (mode === "calls") return { mode, patterns: [`${requireString(name, "name")}($$$ARGS)`] };
  if (mode === "classes") return { mode, patterns: [`class ${requireString(name, "name")} { $$$BODY }`] };

  if (mode === "functions") {
    const fn = requireString(name, "name");
    return {
      mode,
      patterns: tsLike(params.lang)
        ? [
            `function ${fn}($$$ARGS) { $$$BODY }`,
            `function ${fn}($$$ARGS): $$$RET { $$$BODY }`,
            `const ${fn} = ($$$ARGS) => $$$BODY`,
            `const ${fn} = function($$$ARGS) { $$$BODY }`,
            `${fn}($$$ARGS) { $$$BODY }`,
          ]
        : [`function ${fn}($$$ARGS) { $$$BODY }`, `def ${fn}($$$ARGS): $$$BODY`],
    };
  }

  if (mode === "imports") {
    if (!module) return { mode, patterns: ["import $$$IMPORT from $$$MODULE", "import $$$MODULE", "const $$$IMPORT = require($$$MODULE)"] };
    return {
      mode,
      patterns: [
        `import $$$IMPORT from ${quote(module)}`,
        `import ${quote(module)}`,
        `const $$$IMPORT = require(${quote(module)})`,
        `import $$$IMPORT = require(${quote(module)})`,
      ],
    };
  }

  const exported = name ?? "$$$NAME";
  return {
    mode,
    patterns: tsLike(params.lang)
      ? [
          `export function ${exported}($$$ARGS) { $$$BODY }`,
          `export function ${exported}($$$ARGS): $$$RET { $$$BODY }`,
          `export class ${exported} { $$$BODY }`,
          `export const ${exported} = $$$VALUE`,
          name ? `export default function ${exported}($$$ARGS) { $$$BODY }` : "export default function($$$ARGS) { $$$BODY }",
          name ? `export default class ${exported} { $$$BODY }` : "export default class { $$$BODY }",
        ]
      : [`export function ${exported}($$$ARGS) { $$$BODY }`, `pub fn ${exported}($$$ARGS) { $$$BODY }`],
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep_search",
    label: "AST Search",
    description: "AST-aware code search. For calls/imports/functions/classes/exports, set mode plus name/module; use mode=pattern only for custom AST shapes. Use before grep/find/scripts for syntax patterns.",
    promptSnippet: AST_PROMPT_SNIPPET,
    promptGuidelines: AST_GUIDELINES,
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ enum: [...SEARCH_MODES] as string[] })),
      pattern: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      module: Type.Optional(Type.String()),
      lang: Type.String({ enum: [...LANGS] as string[] }),
      paths: Type.Optional(Type.Array(Type.String())),
      context: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _update: unknown, ctx: ToolCtx) {
      try {
        const { mode, patterns } = searchPatterns(params);
        const paths = params.paths?.length ? params.paths : [ctx.cwd ?? "."];
        const matches: SgMatch[] = [];
        const seen = new Set<string>();
        const errors: string[] = [];
        let code: number | null = 0;

        for (const pattern of patterns) {
          const args = ["run", "-p", pattern, "--lang", params.lang, "--json=compact"];
          if (params.context != null) args.push("--context", String(params.context));
          args.push(...paths);
          const result = await sg(args, ctx.cwd);
          if (result.code !== 0 && code === 0) code = result.code;
          if (result.stderr.trim()) errors.push(result.stderr.trim());
          try {
            for (const match of parseSgJson(result.stdout)) {
              const key = matchKey(match);
              if (!seen.has(key)) {
                seen.add(key);
                matches.push(match);
              }
            }
          } catch {
            if (result.stdout.trim()) errors.push(result.stdout.trim());
          }
        }

        if (matches.length > 0) code = 0;
        const fallback = errors.length > 0 ? errors.join("\n") : "No matches";
        return text(formatMatches(matches, fallback), { code, mode, patterns, matches: matches.length });
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), { code: 2 });
      }
    },
  } as any);

  pi.registerTool({
    name: "ast_grep_replace",
    label: "AST Replace",
    description: "AST-aware replacement. Dry-run by default; set apply=true to write changes.",
    promptSnippet: AST_PROMPT_SNIPPET,
    promptGuidelines: AST_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.String(),
      rewrite: Type.String(),
      lang: Type.String({ enum: [...LANGS] as string[] }),
      paths: Type.Array(Type.String()),
      apply: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _update: unknown, ctx: ToolCtx) {
      const args = ["run", "-p", params.pattern, "-r", params.rewrite, "--lang", params.lang];
      if (params.apply) args.push("--update-all");
      else args.push("--json=compact");
      args.push(...params.paths);
      const result = await sg(args, ctx.cwd);
      return text(
        params.apply ? result.stderr || result.stdout || "Applied" : formatSgJson(result.stdout, result.stderr),
        { code: result.code, applied: Boolean(params.apply) },
      );
    },
  } as any);
}
