import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// The front end is an ES module graph with no bundler and no type checker, so
// nothing else in this repo would catch a module that uses a shared helper it
// forgot to import. That is not hypothetical: splitting app.js into modules
// dropped `dayTick` from charts.js and `$` from view-coverage.js, and the
// Overview and Coverage pages both rendered as a single error banner. tsc was
// clean and every other test passed.
//
// These checks are cheap and they close that gap.
// ---------------------------------------------------------------------------
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function modules(): Promise<Map<string, string>> {
  const names = (await readdir(PUBLIC)).filter((f) => f.endsWith(".js")).sort();
  const out = new Map<string, string>();
  for (const n of names) out.set(n, await readFile(join(PUBLIC, n), "utf8"));
  return out;
}

/** Names a module re-exports for others to import. */
function exportsOf(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const n of m[1]!.split(",")) if (n.trim()) out.add(n.trim());
  }
  return out;
}

/** Names a module imports, keyed by the specifier it imports them from. */
function importsOf(src: string): Array<{ from: string; names: string[] }> {
  return [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)].map((m) => ({
    from: m[2]!,
    names: m[1]!.split(",").map((n) => n.trim()).filter(Boolean),
  }));
}

/** Top-level declarations, which is where every helper in these files lives. */
function declarationsOf(body: string): Set<string> {
  return new Set([...body.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/g,
  )].map((m) => m[1]!));
}

const stripImports = (src: string) =>
  src.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]+";/g, "")
     .replace(/^export\s*\{[^}]*\};/gm, "");

/**
 * Keep only the parts of a file that are code.
 *
 * Necessary because these modules are mostly HTML in template literals, and
 * prose matches identifiers: the verdict string "(31pp to go)" made a
 * word-boundary search for `go` fire on a file that never calls it. Quoted
 * strings and comments are dropped entirely; template literals keep only the
 * insides of their `${...}` holes, which is where real references live.
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  const depth: number[] = [];   // brace depth per open template literal
  while (i < src.length) {
    const c = src[i]!;
    if (depth.length === 0) {
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2 || src.length; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
        i++; out += " "; continue;
      }
    }
    if (c === "`") {
      if (depth.length && depth[depth.length - 1] === -1) depth.pop();  // closing
      else depth.push(-1);                                              // opening
      i++; continue;
    }
    if (depth.length && depth[depth.length - 1] === -1) {
      // inside template text: skip it, unless a ${ hole starts
      if (c === "$" && src[i + 1] === "{") { depth.push(1); i += 2; out += " "; continue; }
      i += c === "\\" ? 2 : 1; continue;
    }
    if (depth.length) {
      // inside a ${ } hole: this IS code, but track braces to find its end
      if (c === "{") depth[depth.length - 1]!++;
      if (c === "}") {
        depth[depth.length - 1]!--;
        if (depth[depth.length - 1] === 0) { depth.pop(); i++; out += " "; continue; }
      }
    }
    out += c; i++;
  }
  return out;
}

describe("front-end module graph", () => {
  it("every imported name is actually exported by the module it comes from", async () => {
    const mods = await modules();
    const problems: string[] = [];
    for (const [name, src] of mods) {
      for (const { from, names } of importsOf(src)) {
        const target = from.replace(/^\.\//, "");
        const targetSrc = mods.get(target);
        if (!targetSrc) { problems.push(`${name} imports from missing ${target}`); continue; }
        const available = exportsOf(targetSrc);
        for (const n of names) {
          if (!available.has(n)) problems.push(`${name} imports {${n}} but ${target} does not export it`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("no module uses a shared helper it neither declares nor imports", async () => {
    const mods = await modules();
    const shared = new Set<string>();
    for (const src of mods.values()) for (const n of exportsOf(src)) shared.add(n);

    const problems: string[] = [];
    for (const [name, src] of mods) {
      const imported = new Set(importsOf(src).flatMap((i) => i.names));
      const body = stripImports(src);
      const declared = declarationsOf(body);
      const code = codeOnly(body);
      for (const sym of shared) {
        if (declared.has(sym) || imported.has(sym)) continue;
        // Not preceded by a dot, so `m.channel` never looks like `channel`.
        const used = new RegExp(`(?<![\\w$.])${sym.replace("$", "\\$")}(?![\\w$])`).test(code);
        if (used) problems.push(`${name} uses ${sym} without importing it`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("the server serves every module, so no import can 404", async () => {
    const mods = await modules();
    const server = await readFile(join(PUBLIC, "..", "src", "server.ts"), "utf8");
    for (const name of mods.keys()) {
      const stem = name.replace(/\.js$/, "");
      assert.ok(
        server.includes(`"${stem}"`) || server.includes(`"/${name}"`),
        `${name} exists in public/ but src/server.ts will not serve it`,
      );
    }
  });

  it("index.html loads the graph as a module from a single entry point", async () => {
    const html = await readFile(join(PUBLIC, "index.html"), "utf8");
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/,
      "a classic script tag cannot use import, so the whole graph would fail to load");
    const tags = html.match(/<script[^>]*src=/g) ?? [];
    assert.equal(tags.length, 1, "only /app.js should be loaded directly; the rest is imported");
  });
});
