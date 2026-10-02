#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Full qualification inside the disposable lab container: every NAT scenario three times
# with Chromium, cross-engine runs for the key escalation paths, and coturn conformance.
#   FREEHOP_DISPOSABLE_LAB=yes lab/qualify.sh
set -uo pipefail
cd "$(dirname "$0")"
[[ ${FREEHOP_DISPOSABLE_LAB:-} == yes && $(id -u) == 0 ]] || { echo 'disposable lab container only' >&2; exit 2; }
since=$(date -u +%Y-%m-%dT%H:%M:%S)
scenarios=(direct-eim ipv6-direct hard-pair hard-pair-bridge two-peer-desktop-host hard-pair-gateway
  udpblock-gateway udpblock-pair-gateway hard-pair-host-node udpblock-pair-host-node gate-only)
for trial in 1 2 3; do
  for s in "${scenarios[@]}"; do ./run-scenario.sh "$s" 2>&1 | tail -1; done
done
# Cross-engine: Firefox and WebKit behind the hard NATs, Chromium where a third party is needed.
FREEHOP_BROWSERS=a:firefox,b:webkit,c:chromium ./run-scenario.sh hard-pair-bridge 2>&1 | tail -1
FREEHOP_BROWSERS=a:firefox,b:webkit,g:chromium ./run-scenario.sh hard-pair-gateway 2>&1 | tail -1
FREEHOP_BROWSERS=a:firefox,b:webkit ./run-scenario.sh hard-pair-host-node 2>&1 | tail -1
FREEHOP_BROWSERS=a:firefox,g:chromium ./run-scenario.sh udpblock-gateway 2>&1 | tail -1
FREEHOP_BROWSERS=a:webkit,g:firefox ./run-scenario.sh two-peer-desktop-host 2>&1 | tail -1
FREEHOP_BROWSERS=a:firefox,b:webkit ./run-scenario.sh direct-eim 2>&1 | tail -1
FREEHOP_BROWSERS=a:firefox,b:webkit ./run-scenario.sh ipv6-direct 2>&1 | tail -1
node conformance.mjs 2>&1 | tail -3
echo
node summarize.mjs --since="$since"
