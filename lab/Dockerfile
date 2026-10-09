# SPDX-License-Identifier: Apache-2.0
# Disposable NAT lab: Playwright 1.62 with Chromium, Firefox and WebKit (matching package.json), Linux
# networking tools for topology.sh, miniupnpd for the upnp profile and coturn's turnutils_uclient for
# conformance.mjs. Build and run it with lab/docker.sh; it only works as a --privileged throwaway container.
FROM mcr.microsoft.com/playwright:v1.62.0-noble
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      iproute2 iptables nftables miniupnpd coturn openssl procps conntrack \
    && rm -rf /var/lib/apt/lists/*
