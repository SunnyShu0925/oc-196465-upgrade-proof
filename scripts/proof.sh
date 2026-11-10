#!/usr/bin/env bash
# Driver-lane upgrade proof for PR #196465 (doctor: surface agent-dir read failures).
#
# Published driver openclaw@2026.11.2 creates the settings + auth state, then the
# shipped updater moves that same state to the candidate built from the reviewed
# head. The candidate then runs Doctor on the upgraded state.
set -uo pipefail

STABLE="${STABLE_VERSION:-2026.11.2}"
CANDIDATE_VERSION="${CANDIDATE_VERSION:-2026.11.3}"
TARBALL="${CANDIDATE_TARBALL:?CANDIDATE_TARBALL is required}"
WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"
CHECKOUT="${CHECKOUT_DIR:-$WORKSPACE/openclaw}"

ROOT="${RUNNER_TEMP:-/tmp}/proof"
STATE="$ROOT/state"
PREFIX="$ROOT/npm-prefix"
HOME_FAKE="$ROOT/home"
SUMMARY=/tmp/proof-summary.txt
: >"$SUMMARY"

note() { echo "$*" | tee -a "$SUMMARY"; }
say() { echo | tee -a "$SUMMARY"; echo "=== $* ===" | tee -a "$SUMMARY"; }
verdict_line() { note "  $1  $2"; }

PASS=0
FAIL=0
check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    verdict_line "PASS" "$label${detail:+ — $detail}"
  else
    FAIL=$((FAIL + 1))
    verdict_line "FAIL" "$label${detail:+ — $detail}"
  fi
}

say "environment"
{
  uname -srm
  ldd --version 2>&1 | head -1
  node --version
  echo "HOME=$HOME"
  echo "STATE=$STATE"
  echo "stable=$STABLE candidate=$CANDIDATE_VERSION"
  echo "tarball=$TARBALL ($(stat -c%s "$TARBALL" 2>/dev/null || echo missing) bytes)"
} 2>&1 | tee -a "$SUMMARY"

# ── Step 1: published driver ────────────────────────────────────────────────
say "step 1: install published driver openclaw@$STABLE"
rm -rf "$PREFIX" "$HOME_FAKE"
mkdir -p "$PREFIX" "$HOME_FAKE"
export HOME="$HOME_FAKE"
npm install -g "openclaw@$STABLE" --prefix "$PREFIX" --no-audit --no-fund 2>&1 | tail -5 | tee -a "$SUMMARY"
DRIVER="$PREFIX/bin/openclaw"
note "driver bin: $DRIVER"
"$DRIVER" --version 2>&1 | tee -a "$SUMMARY"

# ── Step 2: isolated state the driver owns ──────────────────────────────────
say "step 2: seed isolated state directory"
rm -rf "$STATE"
mkdir -p "$STATE"
export OPENCLAW_STATE_DIR="$STATE"
note "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR"

# ── Step 3: driver writes operator settings ─────────────────────────────────
say "step 3: driver writes settings (config set)"
"$DRIVER" config set gateway.mode local 2>&1 | tail -2 | tee -a "$SUMMARY"
"$DRIVER" config set gateway.port 19123 2>&1 | tail -2 | tee -a "$SUMMARY"
"$DRIVER" config set logging.level warn 2>&1 | tail -2 | tee -a "$SUMMARY"
note "--- openclaw.json written by driver ---"
cat "$STATE/openclaw.json" | tee -a "$SUMMARY"

# ── Step 4: driver writes an auth profile ───────────────────────────────────
say "step 4: driver writes an auth profile (models auth paste-token)"
TOKEN="sk-ant-oat01-proof-synthetic-$(printf 'a%.0s' $(seq 1 70))"
printf '%s\n' "$TOKEN" | "$DRIVER" models auth paste-token --agent main --provider anthropic --profile-id anthropic:proof 2>&1 | tail -5 | tee -a "$SUMMARY"
PASTE_EXIT=${PIPESTATUS[1]}
note "paste-token exit=$PASTE_EXIT"
"$DRIVER" models auth list --agent main 2>&1 | tail -10 | tee -a "$SUMMARY"
"$DRIVER" models auth list --agent main --json >/tmp/before-auth.json 2>/tmp/before-auth.err || cp /tmp/before-auth.err /tmp/before-auth.json
note "driver auth list --json exit=$? bytes=$(wc -c </tmp/before-auth.json)"
note "--- auth store files written by driver ---"
find "$STATE/agents" -name "*.sqlite" 2>/dev/null | sort | tee -a "$SUMMARY"

# ── Step 5: snapshot before ─────────────────────────────────────────────────
say "step 5: snapshot the driver state (before upgrade)"
node "$WORKSPACE/scripts/config-facts.mjs" "$STATE/openclaw.json" /tmp/before-config.json >/tmp/before-config.txt 2>&1
node "$WORKSPACE/scripts/snapshot-state.mjs" "$STATE" >/tmp/before-state.txt 2>&1
tee -a "$SUMMARY" </tmp/before-config.txt
tee -a "$SUMMARY" </tmp/before-state.txt
AGENT_STORE="$STATE/agents/main/agent/openclaw-agent.sqlite"
note "scan gate store $AGENT_STORE: $([ -f "$AGENT_STORE" ] && echo present || echo absent)"

# ── Step 6: driver baseline Doctor (pre-fix binary) ─────────────────────────
say "step 6: driver Doctor baseline (published 2026.11.2, no fix)"
"$DRIVER" doctor --non-interactive >/tmp/doctor-driver.log 2>&1
note "driver doctor exit=$?"
DRIVER_WARN_HITS=$(grep -c "Cannot list agent directories" /tmp/doctor-driver.log || true)
note "driver 'Cannot list agent directories' matches: $DRIVER_WARN_HITS (expected 0 — the driver predates the fix)"

# ── Step 7: shipped updater, driver → candidate ─────────────────────────────
say "step 7: openclaw update --tag file:<candidate tarball>"
"$DRIVER" update --tag "file:$TARBALL" --yes --timeout 900 --json >/tmp/update.json 2>/tmp/update.err
UPDATE_EXIT=$?
note "update exit=$UPDATE_EXIT"
note "--- update.json ---"
head -c 4000 /tmp/update.json | tee -a "$SUMMARY"
note "--- update stderr (tail) ---"
tail -20 /tmp/update.err | tee -a "$SUMMARY"

# ── Step 8: confirm the candidate is the running binary ─────────────────────
say "step 8: post-upgrade binary identity"
NEW_BIN="$PREFIX/bin/openclaw"
[ -x "$NEW_BIN" ] || NEW_BIN="$(command -v openclaw || true)"
note "post-upgrade bin: ${NEW_BIN:-NOT_FOUND}"
POST_VERSION="$("$NEW_BIN" --version 2>&1 | tail -1)"
note "post-upgrade version: $POST_VERSION"
case "$POST_VERSION" in
  *"$CANDIDATE_VERSION"*) UPGRADED=1 ;;
  *) UPGRADED=0 ;;
esac
check "shipped update replaced the driver with the candidate build" "$UPGRADED" "$POST_VERSION"

# ── Step 9: candidate Doctor completes the state upgrade ────────────────────
say "step 9: candidate Doctor on the upgraded state"
"$NEW_BIN" doctor --fix --non-interactive >/tmp/doctor-candidate-fix.log 2>&1
note "candidate doctor --fix exit=$?"
grep -E "database migrations|state schema|Saved pre-migration|migrated" /tmp/doctor-candidate-fix.log | tee -a "$SUMMARY" || true
"$NEW_BIN" doctor --non-interactive >/tmp/doctor-candidate.log 2>&1
note "candidate doctor exit=$?"
grep -E "Doctor complete|Doctor blocked|required repairs" /tmp/doctor-candidate.log | tee -a "$SUMMARY" || true

# ── Step 10: preservation assertions ───────────────────────────────────────
say "step 10: settings + auth preservation after upgrade"
node "$WORKSPACE/scripts/config-facts.mjs" "$STATE/openclaw.json" /tmp/after-config.json >/tmp/after-config.txt 2>&1
node "$WORKSPACE/scripts/snapshot-state.mjs" "$STATE" >/tmp/after-state.txt 2>&1
tee -a "$SUMMARY" </tmp/after-config.txt
tee -a "$SUMMARY" </tmp/after-state.txt

node "$WORKSPACE/scripts/compare-settings.mjs" /tmp/before-config.json /tmp/after-config.json >/tmp/settings-diff.txt 2>&1
SETTINGS_EXIT=$?
tee -a "$SUMMARY" </tmp/settings-diff.txt
SETTINGS_OK=0
[ "$SETTINGS_EXIT" -eq 0 ] && SETTINGS_OK=1
check "operator settings preserved through the upgrade (gateway, logging, plugins)" "$SETTINGS_OK"

BEFORE_STAMP=$(grep '^meta_lastTouchedVersion: ' /tmp/before-config.txt | cut -d' ' -f2-)
AFTER_STAMP=$(grep '^meta_lastTouchedVersion: ' /tmp/after-config.txt | cut -d' ' -f2-)
STAMP_OK=0
[ "$BEFORE_STAMP" = "$STABLE" ] && [ "$AFTER_STAMP" = "$CANDIDATE_VERSION" ] && STAMP_OK=1
check "config was touched by the upgrading binary" "$STAMP_OK" "$BEFORE_STAMP -> $AFTER_STAMP"

BEFORE_VERSIONS=$(grep 'schema_user_version: ' /tmp/before-state.txt | sort | uniq -c)
AFTER_VERSIONS=$(grep 'schema_user_version: ' /tmp/after-state.txt | sort | uniq -c)
note "state schema versions before: $BEFORE_VERSIONS"
note "state schema versions after:  $AFTER_VERSIONS"
if [ "$BEFORE_VERSIONS" != "$AFTER_VERSIONS" ]; then
  check "state schema migrated by the candidate Doctor" 1
else
  check "state schema migrated by the candidate Doctor" 0 "no user_version change"
fi

"$NEW_BIN" models auth list --agent main --json >/tmp/after-auth.json 2>/tmp/after-auth.err || cp /tmp/after-auth.err /tmp/after-auth.json
node "$WORKSPACE/scripts/compare-auth.mjs" /tmp/before-auth.json /tmp/after-auth.json >/tmp/auth-diff.txt 2>&1
AUTH_EXIT=$?
tee -a "$SUMMARY" </tmp/auth-diff.txt
AUTH_OK=0
[ "$AUTH_EXIT" -eq 0 ] && AUTH_OK=1
check "saved auth profile preserved through the upgrade" "$AUTH_OK"

note "--- rows mentioning the profile, before ---"; grep 'PROFILE_FOUND' /tmp/before-state.txt | tee -a "$SUMMARY" || true
note "--- rows mentioning the profile, after ---"; grep 'PROFILE_FOUND' /tmp/after-state.txt | tee -a "$SUMMARY" || true
note "--- non-empty tables, before ---"; grep '^  nonempty: ' /tmp/before-state.txt | tee -a "$SUMMARY" || true
note "--- non-empty tables, after ---"; grep '^  nonempty: ' /tmp/after-state.txt | tee -a "$SUMMARY" || true

# ── Step 11: the fix, exercised on the upgraded state ──────────────────────
say "step 11: agent-dir read failure surfaces on the upgraded state"
note "--- candidate writes its own profile (satisfies the scan's store gate) ---"
printf '%s\n' "$TOKEN" | "$NEW_BIN" models auth paste-token --agent main --provider anthropic --profile-id anthropic:proof 2>&1 | tail -4 | tee -a "$SUMMARY"
# The scan treats a missing root as ENOENT (silent by design), so the scene needs
# an agents root that exists and cannot be listed.
mkdir -p "$STATE/agents/proof-agent/agent"
note "agents root created: mode=$(stat -c %a "$STATE/agents") entries=$(ls -1 "$STATE/agents" | tr '\n' ' ')"
note "agents root mode before: $(stat -c %a "$STATE/agents")"
chmod 111 "$STATE/agents"
note "agents root mode now:    $(stat -c %a "$STATE/agents") (list denied, traversal kept)"
"$NEW_BIN" doctor --non-interactive >/tmp/doctor-eacces.log 2>&1
note "candidate doctor (execute-only agents root) exit=$?"
EACCES_HITS=$(grep -c "Cannot list agent directories" /tmp/doctor-eacces.log || true)
note "matches: $EACCES_HITS"
grep -A3 "Cannot list agent directories" /tmp/doctor-eacces.log | tee -a "$SUMMARY" || true

chmod 755 "$STATE/agents"
note "agents root mode restored: $(stat -c %a "$STATE/agents")"
"$NEW_BIN" doctor --non-interactive >/tmp/doctor-control.log 2>&1
CONTROL_HITS=$(grep -c "Cannot list agent directories" /tmp/doctor-control.log || true)
note "control matches: $CONTROL_HITS (expected 0)"
check "warning appears only when the agents root cannot be listed" "$([ "$EACCES_HITS" -ge 1 ] && [ "$CONTROL_HITS" -eq 0 ] && echo 1 || echo 0)" "eacces=$EACCES_HITS control=$CONTROL_HITS"

# ── Step 12: repair keeps state ────────────────────────────────────────────
say "step 12: doctor --fix after the scenes keeps state"
"$NEW_BIN" doctor --fix --non-interactive >/tmp/doctor-after-fix.log 2>&1
note "doctor --fix exit=$?"
node "$WORKSPACE/scripts/config-facts.mjs" "$STATE/openclaw.json" /tmp/after-fix-config.json >/tmp/after-fix-config.txt 2>&1
node "$WORKSPACE/scripts/snapshot-state.mjs" "$STATE" >/tmp/after-fix-state.txt 2>&1
node "$WORKSPACE/scripts/compare-settings.mjs" /tmp/before-config.json /tmp/after-fix-config.json >/tmp/settings-fix-diff.txt 2>&1
FIX_EXIT=$?
tee -a "$SUMMARY" </tmp/settings-fix-diff.txt
FIX_OK=0
[ "$FIX_EXIT" -eq 0 ] && FIX_OK=1
check "operator settings still preserved after doctor --fix" "$FIX_OK"
"$NEW_BIN" models auth list --agent main --json >/tmp/after-fix-auth.json 2>/tmp/after-fix-auth.err || cp /tmp/after-fix-auth.err /tmp/after-fix-auth.json
node "$WORKSPACE/scripts/compare-auth.mjs" /tmp/before-auth.json /tmp/after-fix-auth.json >/tmp/auth-fix-diff.txt 2>&1
FIX_AUTH_EXIT=$?
tee -a "$SUMMARY" </tmp/auth-fix-diff.txt
FIX_AUTH_OK=0
[ "$FIX_AUTH_EXIT" -eq 0 ] && FIX_AUTH_OK=1
check "saved auth profile still present after doctor --fix" "$FIX_AUTH_OK"

# ── Verdict ────────────────────────────────────────────────────────────────
say "FINAL VERDICT"
note "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  note "VERDICT=PASS"
  exit 0
fi
note "VERDICT=FAIL"
exit 1
