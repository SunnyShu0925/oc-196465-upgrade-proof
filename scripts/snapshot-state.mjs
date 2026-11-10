#!/usr/bin/env node
// Snapshot operator-visible state for the PR #196465 stable->head upgrade proof.
// Prints SQLite files, schema user_version, and auth rows. Secret material is
// reduced to a shape marker; volatile timestamps are kept out of the FACT lines
// so before/after comparisons stay meaningful.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const root = process.argv[2];
if (!root) {
  console.error("usage: snapshot-state.mjs <state-dir>");
  process.exit(2);
}

const redact = (value) => {
  if (typeof value !== "string") return value;
  if (value.length > 12) return `${value.slice(0, 6)}…(${value.length} chars)`;
  return value;
};

const SECRET_KEY = /token|secret|key|password|cookie/iu;
const VOLATILE_KEY = /updated|timestamp|_at$|checked/iu;

const summarizeValue = (key, value) => {
  if (typeof value !== "string") return value;
  if (key === "store_json" || key === "state_json") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && parsed.profiles && typeof parsed.profiles === "object") {
        const profiles = Object.entries(parsed.profiles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, profile]) => {
            const facts = { id, type: profile?.type, provider: profile?.provider };
            for (const field of ["token", "accessToken", "refreshToken", "apiKey"]) {
              if (profile?.[field] !== undefined) facts[field] = redact(profile[field]);
            }
            return facts;
          });
        return { version: parsed.version, profiles };
      }
    } catch {
      // fall through to the generic redaction
    }
    return redact(value);
  }
  if (SECRET_KEY.test(key)) return redact(value);
  return value;
};

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.sqlite$/u.test(entry.name)) out.push(full);
  }
  return out;
};

const dbs = walk(root).sort();
console.log(`state_dir: ${root}`);
console.log(`sqlite_files: ${dbs.length}`);
for (const dbPath of dbs) console.log(`  - ${path.relative(root, dbPath)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
let index = 0;
for (const dbPath of dbs) {
  const copy = path.join(tmp, `db-${index++}.sqlite`);
  fs.copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
  }
  const rel = path.relative(root, dbPath);
  let db;
  try {
    db = new DatabaseSync(copy);
  } catch (error) {
    console.log(`\n[${rel}] open_failed: ${String(error)}`);
    continue;
  }
  try {
    const version = db.prepare("PRAGMA user_version").get();
    console.log(`\n[${rel}]`);
    console.log(`  schema_user_version: ${version.user_version}`);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    console.log(`  tables: ${tables.length}`);
    for (const table of tables) {
      if (!/profile|auth|credential/iu.test(table)) continue;
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name);
      const rows = db.prepare(`SELECT * FROM "${table}"`).all();
      console.log(`  ${table}: ${rows.length} row(s) columns=${columns.join(",")}`);
      for (const row of rows.slice(0, 20)) {
        const shown = {};
        const facts = {};
        for (const key of Object.keys(row).sort()) {
          const summarized = summarizeValue(key, row[key]);
          shown[key] = summarized;
          if (!VOLATILE_KEY.test(key)) facts[key] = summarized;
        }
        console.log(`    ROW  ${table} ${JSON.stringify(shown)}`);
        console.log(`    FACT ${table} ${JSON.stringify(facts)}`);
      }
    }
  } finally {
    db.close();
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
