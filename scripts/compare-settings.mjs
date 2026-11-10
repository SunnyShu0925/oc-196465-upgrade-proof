#!/usr/bin/env node
// Compare the operator-owned settings sections across an upgrade step. The
// upgrading binary may add its own bookkeeping sections; losing or rewriting a
// section the operator wrote is what this proof rules out.
import fs from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: compare-settings.mjs <before.json> <after.json>");
  process.exit(2);
}

const load = (filePath) => {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const { meta: _meta, ...settings } = parsed.settings ?? parsed;
  return settings;
};
const before = load(beforePath);
const after = load(afterPath);
const OPERATOR_SECTIONS = ["gateway", "logging", "plugins"];

let ok = true;
for (const section of OPERATOR_SECTIONS) {
  const same = JSON.stringify(before[section] ?? null) === JSON.stringify(after[section] ?? null);
  console.log(`  ${same ? "PASS" : "FAIL"}  ${section} preserved`);
  if (!same) {
    ok = false;
    console.log(`        before: ${JSON.stringify(before[section] ?? null)}`);
    console.log(`        after:  ${JSON.stringify(after[section] ?? null)}`);
  }
}

const removed = Object.keys(before).filter((key) => !(key in after));
console.log(`  ${removed.length === 0 ? "PASS" : "FAIL"}  no settings section dropped${removed.length ? ` (dropped: ${removed.join(",")})` : ""}`);
if (removed.length > 0) ok = false;

const added = Object.keys(after).filter((key) => !(key in before));
console.log(`  added_sections: ${added.length > 0 ? added.join(",") : "(none)"}`);
if (!ok) process.exit(1);
