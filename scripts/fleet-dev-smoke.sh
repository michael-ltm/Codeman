#!/usr/bin/env bash
#
# fleet-dev-smoke.sh — end-to-end local two-process smoke test for the Fleet
# Dashboard (Task 15). Boots a "central" codeman (CODEMAN_INSTANCE=fleetc,
# :3100) and a "node" codeman (CODEMAN_INSTANCE=fleetn, `node run` on :3199)
# on this machine, pairs them, creates a remote shell session on the node,
# sends input through it, and asserts the echoed output shows up in the
# central-side terminal buffer.
#
# Isolation: CODEMAN_INSTANCE derives BOTH the data dir (~/.codeman-<instance>)
# AND the tmux socket (-L codeman-<instance>) from one variable (instance.ts).
# Using two distinct instance names (fleetc/fleetn) is therefore sufficient to
# guarantee this script never touches ~/.codeman (production data) or the
# production `codeman` tmux socket — no CODEMAN_DATA_DIR override needed.
# This mirrors the existing convention in scripts/run-beta.sh.
#
# No CODEMAN_PASSWORD is set: both servers bind 127.0.0.1 only, and auth
# middleware is a no-op when CODEMAN_PASSWORD is unset (see
# src/web/middleware/auth.ts) — safe for a throwaway local smoke test, never
# do this for a network-reachable instance.
#
# Usage: ./scripts/fleet-dev-smoke.sh
# Exit 0 + trailing "SMOKE PASS" on success.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CENTRAL_INSTANCE=fleetc
NODE_INSTANCE=fleetn
CENTRAL_PORT=3100
NODE_PORT=3199
CENTRAL_URL="http://127.0.0.1:${CENTRAL_PORT}"
NODE_URL="http://127.0.0.1:${NODE_PORT}"

CENTRAL_DATA_DIR="$HOME/.codeman-${CENTRAL_INSTANCE}"
NODE_DATA_DIR="$HOME/.codeman-${NODE_INSTANCE}"

CENTRAL_PID=""
NODE_PID=""
CENTRAL_LOG="$(mktemp -t fleet-smoke-central.XXXXXX)"
NODE_LOG="$(mktemp -t fleet-smoke-node.XXXXXX)"

cleanup() {
  local status=$?
  # Kill both server processes AND any children they spawned (tmux server,
  # shell PTYs, ...) via process-group kill: each was started with `&` as the
  # leader of its own group under `set -m`-less bash, so `kill -TERM -$pid`
  # signals the whole group. Fall back to `pkill -P` for any stragglers, then
  # a plain kill on the tracked pid. All best-effort — never fail cleanup.
  for pid in "$NODE_PID" "$CENTRAL_PID"; do
    [ -n "$pid" ] || continue
    kill -TERM "-$pid" 2>/dev/null || true
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "$NODE_PID" "$CENTRAL_PID"; do
    [ -n "$pid" ] || continue
    kill -KILL "-$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done

  # Tear down the isolated tmux socket servers this run created. Socket name
  # is `codeman-<instance>` (instance.ts:41: `codeman${INSTANCE_SUFFIX}`,
  # INSTANCE_SUFFIX = `-${CODEMAN_INSTANCE}`). Never touches the production
  # `-L codeman` socket.
  tmux -L "codeman-${CENTRAL_INSTANCE}" kill-server >/dev/null 2>&1 || true
  tmux -L "codeman-${NODE_INSTANCE}" kill-server >/dev/null 2>&1 || true

  # Remove the throwaway per-instance data directories so repeated runs start
  # clean and nothing lingers outside the real ~/.codeman.
  rm -rf "$CENTRAL_DATA_DIR" "$NODE_DATA_DIR"

  if [ "$status" -ne 0 ]; then
    echo "--- central log ($CENTRAL_LOG) ---" >&2
    tail -n 60 "$CENTRAL_LOG" >&2 2>/dev/null || true
    echo "--- node log ($NODE_LOG) ---" >&2
    tail -n 60 "$NODE_LOG" >&2 2>/dev/null || true
  fi
  rm -f "$CENTRAL_LOG" "$NODE_LOG"
  exit "$status"
}
trap cleanup EXIT

echo "==> npm run build"
npm run build

echo "==> starting central (instance=$CENTRAL_INSTANCE, port=$CENTRAL_PORT)"
CODEMAN_INSTANCE="$CENTRAL_INSTANCE" CODEMAN_HOST=127.0.0.1 CODEMAN_PORT="$CENTRAL_PORT" \
  node dist/index.js web >"$CENTRAL_LOG" 2>&1 &
CENTRAL_PID=$!

# Poll for the central HTTP server instead of a fixed sleep: boot time varies
# with disk cache state. 20 x 0.5s = 10s ceiling.
for i in $(seq 1 20); do
  if curl -fsS "$CENTRAL_URL/api/fleet" >/dev/null 2>&1; then
    echo "central ok"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "FAIL: central did not come up on $CENTRAL_URL within 10s" >&2
    exit 1
  fi
  sleep 0.5
done

# 生成配对码 (create a one-time pairing code; unwrap the {success,data} envelope)
CODE=$(curl -fsS -X POST "$CENTRAL_URL/api/fleet/pairing-codes" -H 'content-type: application/json' -d '{}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.code))')
echo "pairing code: $CODE"

# 节点: instance=fleetn (own data dir + tmux socket), join then `node run`.
echo "==> joining node (instance=$NODE_INSTANCE) to central"
CODEMAN_INSTANCE="$NODE_INSTANCE" node dist/index.js node join "$CENTRAL_URL" --code "$CODE" --name smoke-node

echo "==> starting node run (instance=$NODE_INSTANCE, port=$NODE_PORT)"
CODEMAN_INSTANCE="$NODE_INSTANCE" CODEMAN_PORT="$NODE_PORT" \
  node dist/index.js node run >"$NODE_LOG" 2>&1 &
NODE_PID=$!

# Poll for the node's own HTTP server to be up (it runs the same server.ts
# binary, so /api/fleet is always registered — see registerFleetRoutes in
# src/web/server.ts). The FleetNodeAgent's WS `hello` handshake with central
# is checked separately below.
for i in $(seq 1 20); do
  if curl -fsS "$NODE_URL/api/fleet" >/dev/null 2>&1; then
    echo "node ok"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "FAIL: node did not come up on $NODE_URL within 10s" >&2
    exit 1
  fi
  sleep 0.5
done

# 断言: 中央 fleet 状态包含 local + smoke-node 两台在线设备。Poll instead of a
# fixed sleep since the node's `hello` handshake and central's registry
# update happen asynchronously over the WS connection.
DEVICES_OK=""
for i in $(seq 1 20); do
  RESP=$(curl -fsS "$CENTRAL_URL/api/fleet" || echo '{"data":{"devices":[]}}')
  if ONLINE=$(echo "$RESP" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const st=JSON.parse(s).data;
  const online=st.devices.filter(d=>d.status==="online");
  if(online.length<2){process.exit(1)}
  console.log(online.map(d=>d.name).join(", "))})' 2>/dev/null); then
    echo "fleet devices ok: $ONLINE"
    DEVICES_OK=1
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "FAIL devices: $(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).data.devices)))')" >&2
    exit 1
  fi
  sleep 0.5
done
[ -n "$DEVICES_OK" ]

# 远程创建 shell 会话 → 输入 echo → 校验缓冲
DEV=$(curl -fsS "$CENTRAL_URL/api/fleet" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s).data;console.log(st.devices.find(d=>d.name==="smoke-node").id)})')
echo "smoke-node device id: $DEV"

SID=$(curl -fsS -X POST "$CENTRAL_URL/api/fleet/devices/$DEV/sessions" -H 'content-type: application/json' \
  -d "{\"workingDir\":\"$ROOT\",\"mode\":\"shell\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
echo "session id: $SID"

# Give the node's local shell PTY a beat to spawn before we write to it.
sleep 2

# 输入走节点本地 REST (等价校验 mux 路径; 终端 WS 交互由 Task 11 测试覆盖)
curl -fsS -X POST "$NODE_URL/api/sessions/$SID/input" -H 'content-type: application/json' \
  -d '{"input":"echo fleet-ok\n"}' >/dev/null

# Poll the central-side terminal buffer for the echoed output instead of a
# fixed sleep (shell startup + tmux capture round-trip time varies).
for i in $(seq 1 20); do
  if curl -fsS "$CENTRAL_URL/api/fleet/devices/$DEV/sessions/$SID/terminal" | grep -q 'fleet-ok'; then
    echo "SMOKE PASS"
    exit 0
  fi
  if [ "$i" -eq 20 ]; then
    echo "FAIL: 'fleet-ok' never appeared in the terminal buffer within 10s" >&2
    exit 1
  fi
  sleep 0.5
done
