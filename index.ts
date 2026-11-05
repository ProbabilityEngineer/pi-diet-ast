import { spawn } from "node:child_process";
import { mkdtemp, open, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LANGS = ["bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html", "java", "javascript", "json", "kotlin", "lua", "nix", "php", "python", "ruby", "rust", "scala", "solidity", "swift", "tsx", "typescript", "yaml"] as const;
const SEARCH_MODES = ["pattern", "calls", "imports", "functions", "classes", "exports"] as const;
const MAX_PARSE_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 20_000;
const MAX_PREVIEW_LINES = 400;
const AST_PROMPT_SNIPPET =
  "Use AST search first for syntax/code-shape questions and AST replacement for deliberate structural edits; replacements default to dry-run.";
const AST_GUIDELINES = [
  "Use ast_grep_search first for structural code-shape questions, including calls, imports, exports, functions/classes, object literals, decorators, catch blocks, and control flow, even when the target file is unknown.",
  "For calls/imports/functions/classes/exports, set mode plus name/module; use pattern only for custom AST shapes.",
  "AST matching identifies syntax shapes, not resolved symbol identity, types, or conceptual behavior.",
  "Do not make structural code changes from text matches alone; validate the code shape and surrounding context first.",
  "Use ast_grep_replace for structural edits; keep dry-run unless applying an intentional replacement.",
  "Use concrete, syntactically valid ast-grep code patterns (not regex or prose), the source language, and narrowly scoped paths; presets are syntax-specific, not universal across languages.",
  "Treat No matches as an empty result, not proof of absence; inspect error details, correct syntax/language/scope, then try a language-specific custom pattern or inspect the relevant source directly.",
  "Read the matched files to validate context before drawing conclusions or making edits.",
];

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  capture: string;
};
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
  const capture = await mkdtemp(join(tmpdir(), "pi-diet-ast-"));
  const stdoutPath = join(capture, "stdout.txt");
  const stderrPath = join(capture, "stderr.txt");
  const out = await open(stdoutPath, "w", 0o600);
  const err = await open(stderrPath, "w", 0o600);
  let spawnError: Error | undefined;
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve) => {
      const child = spawn(cmd, args, {
        cwd: cwd ?? process.cwd(), shell: false,
        stdio: ["ignore", out.fd, err.fd],
      });
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (exitCode) => resolve(spawnError ? 127 : exitCode));
    });
  } finally {
    await Promise.all([out.close(), err.close()]);
  }
  if (spawnError) await appendFile(stderrPath, String(spawnError));
  await writeFile(join(capture, "invocation.json"), JSON.stringify({ cmd, args, cwd, code }), { mode: 0o600 });
  const stdout = await readCapture(stdoutPath, MAX_PARSE_BYTES);
  const stderr = await readCapture(stderrPath, MAX_PREVIEW_BYTES);
  return { code, stdout: stdout.text, stderr: stderr.text,
    stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, capture };
}

async function readCapture(path: string, limit: number) {
  const size = (await stat(path)).size;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, limit));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(buffer.subarray(0, offset));
    return { text: text + (size <= limit ? decoder.end() : ""), truncated: size > limit };
  } finally {
    await file.close();
  }
}

async function sg(args: string[], cwd?: string) {
  let result = await run("ast-grep", args, cwd);
  if (result.code === 127) {
    result = await run("npx", ["--yes", "@ast-grep/cli", ...args], cwd);
  }
  return result;
}

function parseSgJson(stdout: string): SgMatch[] {
  const raw = stdout.trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  const matches = Array.isArray(data) ? data : [data];
  if (matches.some(match => !match || typeof match !== "object" || Array.isArray(match))) {
    throw new Error("Unexpected ast-grep JSON record");
  }
  return matches;
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

function boundedText(content: string, details: Record<string, unknown>, captures: string[]) {
  let bytes = 0, lines = 1, end = 0;
  for (const character of content) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > MAX_PREVIEW_BYTES || (character === "\n" && lines >= MAX_PREVIEW_LINES)) break;
    bytes += size;
    if (character === "\n") lines++;
    end += character.length;
  }
  const previewTruncated = end < content.length;
  const notice = previewTruncated ? "\n\n[Preview shortened by byte/line limit; later match text may be omitted.]" : "";
  const omitted = Number(details.omittedMatches ?? 0);
  const summary = [
    omitted > 0 ? `[${omitted} parsed matches omitted by the 100-match cap.]` : "",
    details.incomplete === true ? "[Results incomplete or command failed; inspect captured output before drawing conclusions.]" : "",
    details.capturePreviewTruncated === true ? "[Capture preview shortened; complete streams remain in stdout.txt and stderr.txt.]" : "",
  ].filter(Boolean).join("\n");
  return {
    ...text(`${summary ? summary + "\n\n" : ""}${content.slice(0, end)}${notice}\n\nCaptured output: ${captures.join(", ")}\nEach temporary directory contains stdout.txt, stderr.txt, and invocation.json. Read these for omitted evidence; temporary files are not a durable archive.`,
      { ...details, previewTruncated, captures }),
    isError: details.incomplete === true,
  };
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

function callPatterns(name: string): string[] {
  if (name.includes(".")) return [`${name}($$$ARGS)`];
  return [`${name}($$$ARGS)`, `$$$OBJ.${name}($$$ARGS)`];
}

function searchPatterns(params: any): { mode: SearchMode; patterns: string[] } {
  const mode = (params.mode ?? "pattern") as SearchMode;
  if (!SEARCH_MODES.includes(mode)) throw new Error(`Unsupported ast_grep_search mode: ${mode}`);
  if (mode === "pattern") return { mode, patterns: [requireString(params.pattern, "pattern")] };

  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
  const module = typeof params.module === "string" && params.module.trim() ? params.module.trim() : undefined;

  if (mode === "calls") return { mode, patterns: callPatterns(requireString(name, "name")) };
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
        const captures: string[] = [];
        let incomplete = false;
        let code: number | null = 0;

        for (const pattern of patterns) {
          const args = ["run", "-p", pattern, "--lang", params.lang, "--json=compact"];
          if (params.context != null) args.push("--context", String(params.context));
          args.push(...paths);
          const result = await sg(args, ctx.cwd);
          captures.push(result.capture);
          if (result.code === null || (result.code !== 0 && result.code !== 1)) incomplete = true;
          if (result.code !== 0 && code === 0) code = result.code;
          if (result.stderr.trim()) errors.push(result.stderr.trim());
          if (result.stderrTruncated) errors.push("Stderr preview shortened; full stderr.txt is captured.");
          if (result.stdoutTruncated) {
            incomplete = true;
            errors.push("Output exceeds the 8 MiB JSON parsing budget; no partial JSON was parsed. Read stdout.txt.");
            continue;
          }
          try {
            for (const match of parseSgJson(result.stdout)) {
              const key = matchKey(match);
              if (!seen.has(key)) {
                seen.add(key);
                matches.push(match);
              }
            }
          } catch {
            incomplete = true;
            errors.push("Could not parse ast-grep JSON. Read captured stdout.txt; it is not treated as complete results.");
          }
        }

        if (matches.length > 0 && !incomplete) code = 0;
        const fallback = errors.length > 0 ? errors.join("\n") : "No matches";
        const display = formatMatches(matches, fallback);
        return boundedText(matches.length > 0 && errors.length ? `${display}\n\n${errors.join("\n")}` : display,
          { code, mode, matches: matches.length, omittedMatches: Math.max(0, matches.length - 100), incomplete }, captures);
      } catch (error) {
        return { ...text(String(error instanceof Error ? error.message : error).slice(0, 2_000), { code: 2 }), isError: true };
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
      let incomplete = result.code === null || (result.code !== 0 && result.code !== 1);
      let matches: SgMatch[] = [];
      let display: string;
      if (params.apply) {
        display = result.stderr || result.stdout || (incomplete ? "Replacement failed." : "Replacement command completed.");
      } else if (result.stdoutTruncated) {
        incomplete = true;
        display = "Dry-run output exceeds the 8 MiB JSON parsing budget; no partial JSON was parsed. Read stdout.txt.";
      } else {
        try {
          matches = parseSgJson(result.stdout);
          display = formatMatches(matches, result.stderr.trim() || "No matches");
        } catch {
          incomplete = true;
          display = "Could not parse dry-run JSON; inspect captured stdout.txt.";
        }
      }
      return boundedText(display, {
        code: result.code, applied: Boolean(params.apply) && !incomplete,
        applyRequested: Boolean(params.apply), incomplete,
        capturePreviewTruncated: result.stdoutTruncated || result.stderrTruncated,
        matches: matches.length, omittedMatches: Math.max(0, matches.length - 100),
      }, [result.capture]);
    },
  } as any);
}
