#!/usr/bin/env node
// Compare saved auth profiles reported by the CLI before and after an upgrade.
// Identity (id + provider) is what must survive; a later run may add profiles,
// so this checks that every earlier profile is still present and unchanged.
import fs from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: compare-auth.mjs <before.json> <after.json>");
  process.exit(2);
}

const collect = (value, out) => {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const profiles = value.profiles;
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    for (const [id, profile] of Object.entries(profiles)) {
      if (profile && typeof profile === "object" && typeof profile.provider === "string") {
        out.push({ id, provider: profile.provider, mode: profile.mode ?? profile.type ?? null });
      }
    }
    return;
  }
  const id = value.id ?? value.profileId ?? value.profile_id;
  const provider = value.provider ?? value.providerId;
  if (typeof id === "string" && typeof provider === "string") {
    out.push({ id, provider, mode: value.mode ?? value.type ?? null });
    return;
  }
  for (const nested of Object.values(value)) collect(nested, out);
};

// Human-readable `models auth list` lines look like "- anthropic:proof [anthropic/token]".
const parseListText = (text) => {
  const found = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*-\s+(\S+)\s+\[([^/\]]+)\/([^\]]+)\]/u);
    if (match) found.push({ id: match[1], provider: match[2], mode: match[3] });
  }
  return found;
};

const load = (filePath) => {
  const found = [];
  const text = fs.readFileSync(filePath, "utf8");
  try {
    collect(JSON.parse(text), found);
  } catch {
    found.push(...parseListText(text));
  }
  const unique = new Map();
  for (const profile of found) unique.set(profile.id, profile);
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
};

const before = load(beforePath);
const after = load(afterPath);
const describe = (profile) => `${profile.id} (${profile.provider}${profile.mode ? `/${profile.mode}` : ""})`;

console.log(`  before: ${before.length > 0 ? before.map(describe).join(", ") : "(none)"}`);
console.log(`  after:  ${after.length > 0 ? after.map(describe).join(", ") : "(none)"}`);

let ok = before.length > 0;
if (!ok) console.log("  FAIL  the driver state recorded no auth profile to preserve");
const afterById = new Map(after.map((profile) => [profile.id, profile]));
for (const profile of before) {
  const match = afterById.get(profile.id);
  if (!match) {
    console.log(`  FAIL  ${describe(profile)} missing after the upgrade`);
    ok = false;
    continue;
  }
  if (match.provider !== profile.provider) {
    console.log(`  FAIL  ${profile.id} provider ${profile.provider} -> ${match.provider}`);
    ok = false;
    continue;
  }
  console.log(`  PASS  ${describe(match)} preserved`);
}
const added = after.filter((profile) => !before.some((entry) => entry.id === profile.id));
if (added.length > 0) console.log(`  added_profiles: ${added.map(describe).join(", ")}`);
if (!ok) process.exit(1);
