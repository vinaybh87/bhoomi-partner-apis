#!/usr/bin/env bash
set -Eeuo pipefail

readonly BASE_DIR="/home/ubuntu/bhoomi-partner-apis"
readonly INCOMING_DIR="${BASE_DIR}/incoming"
readonly RELEASES_DIR="${BASE_DIR}/releases"
readonly SHARED_DIR="${BASE_DIR}/shared"
readonly CURRENT_LINK="${BASE_DIR}/current"
readonly LOCK_FILE="${BASE_DIR}/deploy.lock"
readonly APP_NAME="bhoomi-partner-apis"
readonly CANDIDATE_NAME="bhoomi-partner-apis-candidate"
readonly CANDIDATE_PORT="8013"

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <artifact.tar.gz> <artifact.sha256> <release-id>" >&2
  exit 2
fi

artifact="$1"
checksum="$2"
release_id="$3"

if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid release id" >&2
  exit 2
fi

artifact="$(realpath "$artifact")"
checksum="$(realpath "$checksum")"
case "$artifact" in "${INCOMING_DIR}"/*) ;; *) echo "artifact must be inside ${INCOMING_DIR}" >&2; exit 2 ;; esac
case "$checksum" in "${INCOMING_DIR}"/*) ;; *) echo "checksum must be inside ${INCOMING_DIR}" >&2; exit 2 ;; esac

for command in node npm pm2 curl tar sha256sum flock; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

[[ -f "${SHARED_DIR}/.env" ]] || { echo "missing ${SHARED_DIR}/.env" >&2; exit 1; }
[[ -f "${SHARED_DIR}/keys/private.pem" ]] || { echo "missing shared private key" >&2; exit 1; }
[[ -f "${SHARED_DIR}/keys/public.pem" ]] || { echo "missing shared public key" >&2; exit 1; }

mkdir -p "$RELEASES_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another deployment is already running" >&2; exit 1; }

cd "$INCOMING_DIR"
sha256sum --check "$(basename "$checksum")"

release_dir="${RELEASES_DIR}/${release_id}"
if [[ -e "$release_dir" ]]; then
  echo "release already exists: $release_dir" >&2
  exit 1
fi

mkdir "$release_dir"
tar -xzf "$artifact" -C "$release_dir"
ln -s "${SHARED_DIR}/.env" "${release_dir}/.env"
ln -s "${SHARED_DIR}/keys" "${release_dir}/keys"

cd "$release_dir"
npm ci
npm run typecheck
npm test
npm run preflight

cleanup_candidate() {
  pm2 delete "$CANDIDATE_NAME" >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT
cleanup_candidate

PORT="$CANDIDATE_PORT" NODE_ENV=production \
  pm2 start npm --name "$CANDIDATE_NAME" --cwd "$release_dir" -- start

candidate_ok=false
for _ in {1..20}; do
  if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${CANDIDATE_PORT}/health" >/dev/null; then
    candidate_ok=true
    break
  fi
  sleep 1
done
[[ "$candidate_ok" == true ]] || { pm2 logs "$CANDIDATE_NAME" --lines 80 --nostream; exit 1; }

previous_release=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(readlink -f "$CURRENT_LINK")"
fi

next_link="${BASE_DIR}/.current-${release_id}"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$CURRENT_LINK"

if ! pm2 startOrReload "${release_dir}/ecosystem.config.cjs" --only "$APP_NAME" --update-env; then
  if [[ -n "$previous_release" ]]; then
    rollback_link="${BASE_DIR}/.current-rollback"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$CURRENT_LINK"
    pm2 startOrReload "${previous_release}/ecosystem.config.cjs" --only "$APP_NAME" --update-env || true
  fi
  exit 1
fi

production_ok=false
for _ in {1..20}; do
  if curl --fail --silent --show-error --max-time 3 'http://127.0.0.1:8011/health' >/dev/null; then
    production_ok=true
    break
  fi
  sleep 1
done

if [[ "$production_ok" != true ]]; then
  pm2 logs "$APP_NAME" --lines 80 --nostream || true
  if [[ -n "$previous_release" ]]; then
    rollback_link="${BASE_DIR}/.current-rollback"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$CURRENT_LINK"
    pm2 startOrReload "${previous_release}/ecosystem.config.cjs" --only "$APP_NAME" --update-env
  else
    pm2 delete "$APP_NAME" || true
  fi
  exit 1
fi

pm2 save
echo "deployed ${release_id} to port 8011"
