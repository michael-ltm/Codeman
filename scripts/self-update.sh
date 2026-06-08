#!/usr/bin/env bash
#
# self-update.sh — apply a Codeman release update from inside the running app.
#
# Spawned DETACHED by the web server (POST /api/system/update → src/web/self-update.ts).
# It outlives the service restart it triggers, so it MUST run from a copy OUTSIDE
# the repo (the server stages it at ~/.codeman/self-update-runner.sh) — `git
# checkout` rewrites the in-repo copy and bash reads scripts lazily.
#
# Reports progress by writing ~/.codeman/update-status.json atomically; the
# browser polls GET /api/system/update/status across the restart drop. The
# freshly-booted server reconciles the final "restarting" → "completed"/"failed".
#
# Cross-platform: restarts via systemd (Linux), launchd (macOS), or prints a
# manual command (foreground installs). Linux launches inside a transient
# systemd scope so `systemctl restart codeman-web` can't kill it mid-build.
#
# Args (all from the server, never user input — tag is validated server-side):
#   --repo <dir> --tag <codeman@X.Y.Z> --supervisor <systemd|launchd|none>
#   --status-file <path> --update-id <uuid> --from-version <ver> --node <path>
#   --log <path> [--prev-sha <sha>] [--stash]
#
set -uo pipefail

REPO=""
TAG=""
SUPERVISOR="none"
STATUS_FILE=""
UPDATE_ID=""
FROM_VERSION=""
NODE="node"
LOG="/dev/null"
PREV_SHA=""
DO_STASH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --supervisor) SUPERVISOR="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    --update-id) UPDATE_ID="$2"; shift 2 ;;
    --from-version) FROM_VERSION="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --prev-sha) PREV_SHA="$2"; shift 2 ;;
    --stash) DO_STASH=1; shift ;;
    *) shift ;;
  esac
done

# All output → the log file (the process is detached, no tty).
exec >>"$LOG" 2>&1 || true
echo "[self-update] $(date) start tag=$TAG supervisor=$SUPERVISOR repo=$REPO"

# Make node/npm/git reachable regardless of the (possibly minimal) service env.
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export GIT_TERMINAL_PROMPT=0

TO_VERSION="${TAG##*@}"   # codeman@0.9.4 → 0.9.4 (tag is validated upstream)
STASH_REF=""
MANUAL_CMD=""

# Write the status file atomically via node (valid JSON, preserves startedAt).
write_status() {
  local phase="$1" message="$2" err="${3:-}"
  STATUS_FILE="$STATUS_FILE" UPDATE_ID="$UPDATE_ID" PHASE="$phase" MESSAGE="$message" \
  FROM_VERSION="$FROM_VERSION" TO_VERSION="$TO_VERSION" TO_TAG="$TAG" PREV_SHA="$PREV_SHA" \
  STASH_REF="$STASH_REF" SUPERVISOR="$SUPERVISOR" ERROR="$err" MANUAL_CMD="$MANUAL_CMD" \
  "$NODE" -e '
    const fs = require("fs");
    const f = process.env.STATUS_FILE;
    let started = 0;
    try { const cur = JSON.parse(fs.readFileSync(f, "utf8")); if (cur && cur.startedAt) started = cur.startedAt; } catch {}
    const s = {
      updateId: process.env.UPDATE_ID,
      phase: process.env.PHASE,
      message: process.env.MESSAGE,
      fromVersion: process.env.FROM_VERSION,
      startedAt: started,
      updatedAt: Date.now(),
    };
    if (process.env.TO_VERSION) s.toVersion = process.env.TO_VERSION;
    if (process.env.TO_TAG) s.toTag = process.env.TO_TAG;
    if (process.env.PREV_SHA) s.prevSha = process.env.PREV_SHA;
    s.stashRef = process.env.STASH_REF || null;
    if (process.env.SUPERVISOR) s.supervisor = process.env.SUPERVISOR;
    if (process.env.ERROR) s.error = process.env.ERROR;
    if (process.env.MANUAL_CMD) s.manualRestartCommand = process.env.MANUAL_CMD;
    const tmp = f + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, f);
  ' || echo "[self-update] WARN: status write failed ($phase)"
}

fail() {
  local msg="$1" err="${2:-}"
  echo "[self-update] FAILED: $msg ($err)"
  write_status "failed" "$msg" "$err"
  exit 1
}

# Restore the previous commit + working build so the still-running server keeps
# serving good code. We do NOT restart on failure.
rollback_and_fail() {
  local msg="$1"
  echo "[self-update] $msg — rolling back to ${PREV_SHA:-<none>}"
  if [[ -n "$PREV_SHA" ]]; then
    git checkout --force "$PREV_SHA" >/dev/null 2>&1 || true
    npm install --no-fund --no-audit >/dev/null 2>&1 || true
    npm run build >/dev/null 2>&1 || true
  fi
  fail "$msg — rolled back to the previous version" "$msg"
}

cd "$REPO" || fail "Install directory not found" "cd $REPO"
git rev-parse --git-dir >/dev/null 2>&1 || fail "Not a git repository" "$REPO"

write_status "preparing" "Preparing update to v$TO_VERSION…"

# 1) Stash local changes (left for the user to pop — never auto-popped).
if [[ "$DO_STASH" == "1" ]]; then
  write_status "stashing" "Stashing local changes…"
  STASH_MSG="codeman-pre-update-$UPDATE_ID"
  if git stash push -u -m "$STASH_MSG" >/dev/null 2>&1; then
    STASH_REF="$STASH_MSG"
    echo "[self-update] stashed local changes as $STASH_MSG"
  fi
fi

# 2) Fetch the target tag.
write_status "fetching" "Fetching $TAG…"
git fetch --tags --force origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null \
  || git fetch --tags --force origin \
  || fail "Could not fetch the release" "git fetch $TAG"

# 3) Check out the release tag (detached HEAD at the release).
write_status "checkout" "Checking out $TAG…"
git -c advice.detachedHead=false checkout --force "$TAG" || rollback_and_fail "Could not check out $TAG"

# 4) Install dependencies.
write_status "installing" "Installing dependencies…"
npm install --no-fund --no-audit || rollback_and_fail "Dependency install failed"

# 5) Build (gate the restart on success — never restart into a torn dist/).
write_status "building" "Building…"
npm run build || rollback_and_fail "Build failed"

# 6) Restart the service so the new code loads. Write the terminal pre-restart
#    marker FIRST so the freshly-booted server can reconcile it deterministically.
write_status "restarting" "Restarting Codeman…"
echo "[self-update] build OK, restarting via $SUPERVISOR"

case "$SUPERVISOR" in
  systemd)
    systemctl --user restart codeman-web.service \
      || fail "Build succeeded but restart failed — run: systemctl --user restart codeman-web" "systemctl restart"
    ;;
  launchd)
    launchctl kickstart -k "gui/$(id -u)/com.codeman.web" 2>/dev/null || {
      PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST" 2>/dev/null \
        || fail "Build succeeded but launchd restart failed" "launchctl"
    }
    ;;
  *)
    MANUAL_CMD="pkill -f 'codeman.*web'; codeman web &"
    write_status "completed-needs-manual-restart" "Update staged — restart Codeman to apply v$TO_VERSION."
    echo "[self-update] no supervisor — manual restart required"
    exit 0
    ;;
esac

echo "[self-update] restart issued; done"
exit 0
