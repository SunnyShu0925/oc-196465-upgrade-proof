#!/usr/bin/env node
// Snapshot operator-visible state for the PR #196465 stable->head upgrade proof.
// Prints every non-empty table with secrets reduced to shape markers, and keeps
// volatile timestamps out of the FACT lines so before/after comparisons mean
// something.
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
const IDENTITY_KEYS = ["id", "profileId", "profile_id", "name"];

const summarizeJson = (text) => {
  try {
    const parsed = JSON.parse(text);
    const profiles = parsed?.profiles;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      const entries = Object.entries(profiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, profile]) => {
          const facts = { id, provider: profile?.provider, mode: profile?.mode, type: profile?.type };
          for (const field of ["token", "accessToken", "refreshToken", "apiKey"]) {
            if (profile?.[field] !== undefined) facts[field] = redact(profile[field]);
          }
          return facts;
        });
      return { version: parsed.version, profiles: entries };
    }
  } catch {
    // not JSON; fall through
  }
  return redact(text);
};

const summarizeValue = (key, value) => {
  if (typeof value !== "string") return value;
  if (/json$/iu.test(key)) return summarizeJson(value);
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
      .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .all("table")
      .map((row) => row.name);
    const counts = [];
    const authTables = [];
    for (const table of tables) {
      const count = db.prepare(`SELECT count(*) AS c FROM "${table}"`).get().c;
      counts.push(`${table}(${count})`);
      if (/profile|auth|credential|secret/iu.test(table)) authTables.push(`${table}(${count})`);
      if (count === 0) continue;
      const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 3`).all();
      for (const row of rows) {
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
    console.log(`  tables: ${tables.length}`);
    console.log(`  nonempty: ${counts.filter((entry) => !/\(0\)$/u.test(entry)).join(",") || "(none)"}`);
    console.log(`  auth_tables: ${authTables.join(",") || "(none)"}`);
    for (const table of tables) {
      const count = db.prepare(`SELECT count(*) AS c FROM "${table}"`).get().c;
      if (count === 0) continue;
      const rows = db.prepare(`SELECT * FROM "${table}"`).all();
      for (const row of rows) {
        const text = JSON.stringify(row);
        if (!text.includes("anthropic:proof")) continue;
        const marker = {};
        for (const key of Object.keys(row).sort()) {
          if (IDENTITY_KEYS.includes(key) || /provider|mode|type/iu.test(key)) marker[key] = row[key];
          else marker[key] = summarizeValue(key, row[key]);
        }
        console.log(`  PROFILE_FOUND ${table} ${JSON.stringify(marker)}`);
      }
    }
  } finally {
    db.close();
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
