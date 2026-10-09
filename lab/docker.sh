#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Runs the NAT lab in a disposable, privileged Docker container (Docker Desktop on macOS, or Docker on
# Linux). The container gets its own network namespaces; the repository is mounted so evidence lands in
# test/evidence. Nothing persists after a run except the image and the evidence files.
#   lab/docker.sh hard-pair      one scenario (FREEHOP_BROWSER / FREEHOP_BROWSERS pass through)
#   lab/docker.sh qualify        the full qualification (lab/qualify.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:?usage: lab/docker.sh <scenario|qualify>}
image=freehop-nat-lab:local
docker build -q -t "$image" lab >/dev/null
if [[ $target == qualify ]]; then run=lab/qualify.sh; else run="lab/run-scenario.sh $target"; fi
exec docker run --rm --privileged --sysctl net.ipv6.conf.all.disable_ipv6=0 --sysctl net.ipv6.conf.default.disable_ipv6=0 \
  -e FREEHOP_DISPOSABLE_LAB=yes -e FREEHOP_BROWSER -e FREEHOP_BROWSERS -v "$PWD":/freehop -w /freehop "$image" bash -c "$run"
