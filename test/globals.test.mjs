import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Apps Script loads every file into ONE shared global scope (the browser does the same
 * for core/ via plain <script> tags). Two top-level declarations with the same name in
 * different files silently clobber each other — Node's per-module scope hides this, so
 * unit tests pass while the deployed code misbehaves (namesWithAnswer once had two
 * incompatible signatures and hold emails reported "no confirmed attendees").
 *
 * Rule: a top-level function name may exist in only ONE deployed file. Top-level vars
 * may repeat only when every occurrence is textually identical (e.g. the Sched
 * namespace bootstrap line).
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["core", "gas"].flatMap((d) =>
  fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".js")).map((f) => path.join(d, f)));

function topLevelDecls(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const decls = [];
  for (const line of src.split("\n")) {
    let m = /^function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) decls.push({ kind: "function", name: m[1], text: line.trim() });
    m = /^var\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) decls.push({ kind: "var", name: m[1], text: line.trim() });
  }
  return decls;
}

test("no top-level name is declared in more than one deployed file (GAS shared scope)", () => {
  const byName = new Map();
  for (const file of files) {
    for (const d of topLevelDecls(file)) {
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push({ file, ...d });
    }
  }
  const problems = [];
  for (const [name, occ] of byName) {
    const filesWith = new Set(occ.map((o) => o.file));
    if (filesWith.size < 2) continue;
    if (occ.some((o) => o.kind === "function")) {
      problems.push(`function "${name}" declared in: ${[...filesWith].join(", ")}`);
    } else if (new Set(occ.map((o) => o.text)).size > 1) {
      problems.push(`var "${name}" differs across: ${[...filesWith].join(", ")}`);
    }
  }
  assert.deepEqual(problems, []);
});
