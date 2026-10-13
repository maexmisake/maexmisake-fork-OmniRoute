#!/usr/bin/env bash
# Smoke-test a locally loaded OmniRoute image for the native System One routes.
#
#   scripts/ci/systemone-image-smoke.sh <image-ref> <evidence-dir>
#
# Everything is synthetic and local:
#   * the app container runs the image with random throw-away secrets and no volumes;
#   * the "upstream" is scripts/ci/systemone-mock-upstream.mjs, run inside the same image
#     on a private --internal network where it owns the hostname `opencode.ai`, with a
#     throw-away CA trusted only by the app container (docker cp, no bind mounts);
#   * no registry login, no push, no real provider key, no privileged mode.
# Containers and the network are removed on every exit path.
set -Eeuo pipefail

IMAGE="${1:?usage: systemone-image-smoke.sh <image-ref> <evidence-dir>}"
EVIDENCE_DIR="${2:?usage: systemone-image-smoke.sh <image-ref> <evidence-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 2; }

SUFFIX="${SYSTEMONE_SMOKE_SUFFIX:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$}"
NET="systemone-verify-${SUFFIX}"
APP="systemone-verify-${SUFFIX}-app"
MOCK="systemone-verify-${SUFFIX}-mock"
WORK="$(mktemp -d)"
STATUS=0

mkdir -p "$EVIDENCE_DIR"

rand() { openssl rand -hex 24; }
JWT_SECRET="$(rand)"
API_KEY_SECRET="$(rand)"
INITIAL_PASSWORD="ci-$(rand)"
MOCK_PAID_KEY="ci-paid-$(rand)"
MOCK_FREE_KEY="ci-free-$(rand)"
MOCK_STATE_MARKER="canary-$(rand)"
export JWT_SECRET API_KEY_SECRET INITIAL_PASSWORD MOCK_PAID_KEY MOCK_FREE_KEY MOCK_STATE_MARKER

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  for value in "$JWT_SECRET" "$API_KEY_SECRET" "$INITIAL_PASSWORD" "$MOCK_PAID_KEY" "$MOCK_FREE_KEY" "$MOCK_STATE_MARKER"; do
    echo "::add-mask::${value}"
  done
fi

# Replace every synthetic secret (and any bearer token) in the stream with a placeholder.
redact() {
  node -e '
    const secrets = ["JWT_SECRET","API_KEY_SECRET","INITIAL_PASSWORD","MOCK_PAID_KEY","MOCK_FREE_KEY","MOCK_STATE_MARKER"]
      .map((name) => process.env[name]).filter(Boolean);
    let text = require("node:fs").readFileSync(0, "utf8");
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    process.stdout.write(text.replace(/(bearer\s+)[^\s"]+/gi, "$1[redacted]"));
  '
}

contains_secret() {
  node -e '
    const secrets = ["JWT_SECRET","API_KEY_SECRET","INITIAL_PASSWORD","MOCK_PAID_KEY","MOCK_FREE_KEY","MOCK_STATE_MARKER"]
      .map((name) => process.env[name]).filter(Boolean);
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    process.exit(secrets.some((secret) => text.includes(secret)) ? 0 : 1);
  ' "$1"
}

collect_and_cleanup() {
  local exit_code=$?
  set +e
  trap - EXIT INT TERM
  if docker inspect "$APP" >/dev/null 2>&1; then
    docker logs "$APP" >"$WORK/app.log" 2>&1
    if contains_secret "$WORK/app.log"; then
      echo "FAIL  the app container log contains a synthetic secret or the canary state" >&2
      STATUS=1
    fi
    tail -n 400 "$WORK/app.log" | redact >"$EVIDENCE_DIR/app-container.log"
    docker inspect --format '{{json .State.Health}}' "$APP" 2>/dev/null |
      node -e 'const h=JSON.parse(require("node:fs").readFileSync(0,"utf8")||"null"); console.log(JSON.stringify({status:h&&h.Status,failingStreak:h&&h.FailingStreak}))' \
        >"$EVIDENCE_DIR/app-health.json" 2>/dev/null
  fi
  if docker inspect "$MOCK" >/dev/null 2>&1; then
    docker logs "$MOCK" 2>&1 | grep '^{' | redact >"$EVIDENCE_DIR/mock-upstream-calls.jsonl"
  fi
  docker image inspect --format '{"id":"{{.Id}}","sizeBytes":{{.Size}},"os":"{{.Os}}","arch":"{{.Architecture}}"}' "$IMAGE" \
    >"$EVIDENCE_DIR/image.json" 2>/dev/null
  docker rm -f -v "$APP" "$MOCK" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$exit_code" -ne 0 ] && [ "$STATUS" -eq 0 ]; then STATUS=$exit_code; fi
  exit "$STATUS"
}
trap collect_and_cleanup EXIT INT TERM

# ── throw-away CA: a single self-signed certificate for opencode.ai ─────────────────
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=opencode.ai" \
  -addext "subjectAltName=DNS:opencode.ai" \
  -keyout "$WORK/mock-key.pem" -out "$WORK/mock-cert.pem" >/dev/null 2>&1
chmod 644 "$WORK/mock-key.pem" "$WORK/mock-cert.pem"

# ── mock upstream: internal network only (no route out), same image, no volumes ─────
docker network create --internal "$NET" >/dev/null
docker create --name "$MOCK" --network "$NET" --network-alias opencode.ai \
  --label "systemone-verify=${SUFFIX}" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  -e MOCK_PAID_KEY -e MOCK_FREE_KEY -e MOCK_STATE_MARKER \
  -e MOCK_CERT_FILE=/tmp/mock-cert.pem -e MOCK_KEY_FILE=/tmp/mock-key.pem -e MOCK_PORT=443 \
  --entrypoint node "$IMAGE" /tmp/systemone-mock-upstream.mjs >/dev/null
docker cp "$HERE/systemone-mock-upstream.mjs" "$MOCK:/tmp/systemone-mock-upstream.mjs"
docker cp "$WORK/mock-cert.pem" "$MOCK:/tmp/mock-cert.pem"
docker cp "$WORK/mock-key.pem" "$MOCK:/tmp/mock-key.pem"
docker start "$MOCK" >/dev/null

for _ in $(seq 1 30); do
  if docker logs "$MOCK" 2>&1 | grep -q '"event":"listening"'; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$MOCK")" != "true" ]; then
    echo "FAIL  the mock upstream exited during startup" >&2
    docker logs "$MOCK" 2>&1 | redact | tail -n 40 >&2
    exit 1
  fi
  sleep 1
done
docker logs "$MOCK" 2>&1 | grep -q '"event":"listening"' || { echo "FAIL  the mock upstream never listened" >&2; exit 1; }

# ── app container: published only on the runner's loopback, trusts only our CA ──────
docker create --name "$APP" --network "$NET" --label "systemone-verify=${SUFFIX}" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 3g \
  -p 127.0.0.1::20128 \
  -e JWT_SECRET -e API_KEY_SECRET -e INITIAL_PASSWORD \
  -e REQUIRE_API_KEY=true -e DISABLE_SQLITE_AUTO_BACKUP=true \
  -e NODE_EXTRA_CA_CERTS=/tmp/systemone-mock-ca.pem \
  "$IMAGE" >/dev/null
docker cp "$WORK/mock-cert.pem" "$APP:/tmp/systemone-mock-ca.pem"
docker start "$APP" >/dev/null

PORT="$(docker port "$APP" 20128/tcp | head -n 1 | sed 's/.*://')"
BASE_URL="http://127.0.0.1:${PORT}"

echo "Waiting for ${BASE_URL}/healthz"
ready=0
for _ in $(seq 1 120); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP")" != "true" ]; then
    echo "FAIL  the app container exited during startup" >&2
    docker logs "$APP" 2>&1 | redact | tail -n 80 >&2
    exit 1
  fi
  if curl -fsS --max-time 3 "${BASE_URL}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || { echo "FAIL  /healthz never answered" >&2; docker logs "$APP" 2>&1 | redact | tail -n 80 >&2; exit 1; }

APP_UID="$(docker exec "$APP" id -u)"
echo "app container runs as uid ${APP_UID}"
if [ "$APP_UID" = "0" ]; then
  echo "FAIL  the image runs as root" >&2
  STATUS=1
fi

SMOKE_BASE_URL="$BASE_URL" SMOKE_ADMIN_PASSWORD="$INITIAL_PASSWORD" \
  SMOKE_PAID_KEY="$MOCK_PAID_KEY" SMOKE_FREE_KEY="$MOCK_FREE_KEY" SMOKE_STATE_MARKER="$MOCK_STATE_MARKER" \
  SMOKE_MOCK_CONTAINER="$MOCK" SMOKE_EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$HERE/systemone-smoke.mjs" || STATUS=1

# The image's own HEALTHCHECK must also report healthy (interval 30s, start period 15s).
healthy=0
for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP")" = "healthy" ]; then healthy=1; break; fi
  sleep 5
done
if [ "$healthy" -eq 1 ]; then
  echo "PASS  the image HEALTHCHECK reports healthy"
else
  echo "FAIL  the image HEALTHCHECK never reported healthy" >&2
  STATUS=1
fi

exit "$STATUS"
