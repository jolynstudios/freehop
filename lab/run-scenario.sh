#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run one NAT-lab scenario (or "all") inside the disposable lab container:
#   FREEHOP_DISPOSABLE_LAB=yes lab/run-scenario.sh hard-pair-bridge
set -euo pipefail
cd "$(dirname "$0")"
[[ ${FREEHOP_DISPOSABLE_LAB:-} == yes && $(id -u) == 0 ]] || { echo 'disposable lab container only' >&2; exit 2; }
run() {
  local spec; spec=$(node nat-run.mjs --topology "$1")
  # shellcheck disable=SC2086
  ./topology.sh $spec -- node nat-run.mjs "$1"
}
if [[ "${1:?scenario}" == all ]]; then
  status=0
  for s in direct-eim hard-pair hard-pair-bridge two-peer-desktop-host hard-pair-gateway udpblock-gateway udpblock-pair-gateway gate-only; do
    run "$s" || status=1
  done
  exit $status
fi
run "$1"
