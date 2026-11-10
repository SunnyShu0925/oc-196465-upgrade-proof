#!/usr/bin/env node
// Print settings facts for the upgrade proof: the operator-visible values, plus
// the touched-version marker that the upgrading binary rewrites. When an output
// path is given, write the same values as JSON for compare-settings.mjs.
import fs from "node:fs";

const [configPath, outPath] = process.argv.slice(2);
if (!configPath) {
  console.error("usage: config-facts.mjs <openclaw.json> [facts.json]");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { meta, ...settings } = raw;
const facts = {
  settings,
  meta_last_touched_version: meta?.lastTouchedVersion ?? null,
};
if (outPath) fs.writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`);
console.log(`settings_without_meta: ${JSON.stringify(settings)}`);
console.log(`settings_sections: ${Object.keys(settings).sort().join(",")}`);
console.log(`meta_lastTouchedVersion: ${facts.meta_last_touched_version ?? "<absent>"}`);
console.log(`gateway_mode: ${settings?.gateway?.mode ?? "<absent>"}`);
console.log(`gateway_port: ${settings?.gateway?.port ?? "<absent>"}`);
console.log(`logging_level: ${settings?.logging?.level ?? "<absent>"}`);
