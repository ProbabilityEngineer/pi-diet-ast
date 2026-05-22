import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LANGS = ["bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html", "java", "javascript", "json", "kotlin", "lua", "nix", "php", "python", "ruby", "rust", "scala", "solidity", "swift", "tsx", "typescript", "yaml"] as const;
const MAX_OUTPUT = 60_000;
const AST_PROMPT_SNIPPET =
  "Tool routing: use ast_grep_search first for structural code patterns; use grep for literal text.";
const AST_GUIDELINES = [
  "Use ast_grep_search as the first search tool for structural code patterns such as functions, calls, imports, catch blocks, Tasks, or control flow; use grep for exact literals.",
  "Use Semble for behavior discovery and LSP for known symbols/callsites.",
];

type RunResult = { code: number | null; stdout: string; stderr: string };
type ToolCtx = { cwd?: string };

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

function formatSgJson(stdout: string, stderr: string) {
  const raw = stdout.trim();
  if (!raw) return stderr.trim() || "No matches";
  try {
    const data = JSON.parse(raw);
    const matches = Array.isArray(data) ? data : [data];
    if (matches.length === 0) return "No matches";
    return matches
      .slice(0, 100)
      .map((match: any) => {
        const file = match.file ?? match.path ?? "?";
        const start = match.range?.start;
        const line = typeof start?.line === "number" ? start.line + 1 : "?";
        const body = String(match.text ?? match.lines ?? "").trim();
        return `${file}:${line}\n${body}`;
      })
      .join("\n\n---\n");
  } catch {
    return raw || stderr.trim();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep_search",
    label: "AST Search",
    description: "AST-aware code search. Use code-shaped patterns, not regex/text. Examples: foo($$$ARGS), function $NAME($$$ARGS) { $$$BODY }.",
    promptSnippet: AST_PROMPT_SNIPPET,
    promptGuidelines: AST_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.String(),
      lang: Type.String({ enum: [...LANGS] as string[] }),
      paths: Type.Optional(Type.Array(Type.String())),
      context: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _update: unknown, ctx: ToolCtx) {
      const args = ["run", "-p", params.pattern, "--lang", params.lang, "--json=compact"];
      if (params.context != null) args.push("--context", String(params.context));
      args.push(...(params.paths?.length ? params.paths : [ctx.cwd ?? "."]));
      const result = await sg(args, ctx.cwd);
      return text(formatSgJson(result.stdout, result.stderr), { code: result.code });
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
