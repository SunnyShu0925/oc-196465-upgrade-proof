#!/usr/bin/env node
// Print settings facts for the upgrade proof: values minus the version stamp,
// plus the touched-version marker that the upgrading binary rewrites.
import fs from "node:fs";

const [configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("usage: config-facts.mjs <openclaw.json>");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { meta, ...settings } = raw;
console.log(`settings_without_meta: ${JSON.stringify(settings)}`);
console.log(`meta_lastTouchedVersion: ${meta?.lastTouchedVersion ?? "<absent>"}`);
console.log(`gateway_mode: ${settings?.gateway?.mode ?? "<absent>"}`);
console.log(`gateway_port: ${settings?.gateway?.port ?? "<absent>"}`);
console.log(`logging_level: ${settings?.logging?.level ?? "<absent>"}`);
