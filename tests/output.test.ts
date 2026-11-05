import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index.ts";

const tools: any[] = [];
register({ registerTool(tool: unknown) { tools.push(tool); } } as any);
const record = (i: number, body = "needle()") => ({
  file: "src/example.ts", text: body, range: { start: { line: i, column: 0 } },
});

async function fake(t: any, stdout: string, callback: (cwd: string) => Promise<void>, code = 0, stderr = "") {
  const dir = await mkdtemp(join(tmpdir(), "ast-test-"));
  const oldPath = process.env.PATH;
  await writeFile(join(dir, "output"), stdout);
  await writeFile(join(dir, "error"), stderr);
  const script = join(dir, "ast-grep");
  await writeFile(script, `#!${process.execPath}
const fs = require("fs"), path = require("path");
fs.writeSync(1, fs.readFileSync(path.join(__dirname, "output")));
fs.writeSync(2, fs.readFileSync(path.join(__dirname, "error")));
process.exit(${code});
`);
  await chmod(script, 0o700);
  process.env.PATH = `${dir}:${oldPath}`;
  try { await callback(dir); }
  finally { process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); }
}

async function execute(t: any, cwd: string, replace = false, apply = false) {
  const tool = tools.find(tool => tool.name === (replace ? "ast_grep_replace" : "ast_grep_search"));
  const result = await tool.execute("test", {
    pattern: "needle()", rewrite: "replacement()", lang: "typescript", paths: [cwd], apply,
  }, undefined, undefined, { cwd });
  for (const path of result.details.captures ?? []) t.after(() => rm(path, { recursive: true, force: true }));
  return result;
}

test("search reports omitted matches and preserves every raw record", async t => {
  const raw = JSON.stringify(Array.from({ length: 150 }, (_, i) => record(i)));
  await fake(t, raw, async cwd => {
    const result = await execute(t, cwd);
    assert.match(result.content[0].text, /50 parsed matches omitted/);
    assert.equal(result.details.matches, 150);
    assert.equal(result.isError, false);
    assert.equal(await readFile(join(result.details.captures[0], "stdout.txt"), "utf8"), raw);
  });
});

for (const replace of [false, true]) {
  test(`${replace ? "dry-run" : "search"} bounds huge Unicode bodies, not the capture`, async t => {
    const raw = JSON.stringify([record(0, "🔑".repeat(100_000))]);
    await fake(t, raw, async cwd => {
      const result = await execute(t, cwd, replace);
      assert.ok(Buffer.byteLength(result.content[0].text) < 24_000);
      assert.ok(!result.content[0].text.includes("\uFFFD"));
      assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 2_000);
      assert.equal(result.details.previewTruncated, true);
      assert.equal(result.isError, false);
      assert.equal(await readFile(join(result.details.captures[0], "stdout.txt"), "utf8"), raw);
    });
  });
  test(`${replace ? "dry-run" : "search"} never parses an oversized JSON prefix`, async t => {
    const raw = JSON.stringify([record(0, "x".repeat(9 * 1024 * 1024))]);
    await fake(t, raw, async cwd => {
      const result = await execute(t, cwd, replace);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no partial JSON was parsed/);
      assert.equal(result.details.matches, 0);
      assert.equal(await readFile(join(result.details.captures[0], "stdout.txt"), "utf8"), raw);
    });
  });
  test(`${replace ? "dry-run" : "search"} reports malformed JSON without echoing it`, async t => {
    await fake(t, '{"secretBody":', async cwd => {
      const result = await execute(t, cwd, replace);
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.content[0].text, /secretBody/);
    });
  });
}

test("failed apply does not claim success and preserves large stderr", async t => {
  const stderr = "failed\n".repeat(20_000);
  await fake(t, "", async cwd => {
    const result = await execute(t, cwd, true, true);
    assert.equal(result.isError, true);
    assert.equal(result.details.applied, false);
    assert.ok(Buffer.byteLength(result.content[0].text) < 24_000);
    assert.equal(await readFile(join(result.details.captures[0], "stderr.txt"), "utf8"), stderr);
  }, 2, stderr);
});

test("real CLI dry-run leaves source untouched", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ast-live-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "example.ts");
  const source = "needle();\n";
  await writeFile(file, source);
  const result = await execute(t, cwd, true);
  assert.equal(result.isError, false);
  assert.equal(result.details.applied, false);
  assert.equal(result.details.matches, 1);
  assert.equal(await readFile(file, "utf8"), source);
});
