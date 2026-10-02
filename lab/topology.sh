#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Disposable NAT lab for peerlane. Runs ONLY inside the throwaway privileged lab container
# (FREEHOP_DISPOSABLE_LAB=yes, root). Builds an isolated stand-in for the public internet
# (bridge pl-inet, 198.20.113.0/24, gate host at .1 — not a documentation prefix because
# miniupnpd refuses to map ports behind reserved addresses; nothing leaves the container)
# plus one router/client namespace pair per peer, each with a NAT profile, runs the given
# command, and removes everything it created on exit.
#
#   topology.sh a=random b=udpblock c=public g=upnp -- command args...
#
# Profiles:
#   eim       home router: Linux SNAT (endpoint-independent mapping, port-restricted filtering)
#   random    hard NAT: fully random per-destination UDP ports (symmetric, CGNAT-like)
#   udpblock  corporate firewall: EIM NAT, every forwarded UDP datagram dropped
#   upnp      home router with miniupnpd (UPnP IGD + NAT-PMP + PCP), EIM NAT
#   public    no NAT: the client sits directly on the internet bridge
#   gateonly  only TCP to/from the gate host is forwarded; everything else dropped
#   v6        IPv4 UDP blocked, but routed IPv6 behind a normal stateful firewall
set -euo pipefail
[[ ${FREEHOP_DISPOSABLE_LAB:-} == yes && $(id -u) == 0 ]] || { echo 'disposable lab container only' >&2; exit 2; }
declare -A profile
names=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  [[ "$1" =~ ^([a-z])=(eim|random|udpblock|upnp|public|gateonly|v6)$ ]] || { echo "bad peer spec $1" >&2; exit 2; }
  profile[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}; names+=("${BASH_REMATCH[1]}"); shift
done
[[ "${1:-}" == "--" ]] && shift
! ip link show pl-inet >/dev/null 2>&1 || { echo 'lab bridge already exists' >&2; exit 2; }
rundir=$(mktemp -d /tmp/peerlane-lab.XXXXXX)
cleanup() {
  for name in "${names[@]}"; do
    for ns in "pl-$name" "pl-r$name"; do
      ip netns pids "$ns" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
    done
  done
  sleep 0.2
  for name in "${names[@]}"; do
    for ns in "pl-$name" "pl-r$name"; do
      ip netns pids "$ns" 2>/dev/null | xargs -r kill -KILL 2>/dev/null || true
      ip netns del "$ns" 2>/dev/null || true
    done
  done
  ip link del pl-inet 2>/dev/null || true
  for r in $(ip -6 route show | grep -o '^2001:db8:113:[0-9]*::/64'); do ip -6 route del "$r" 2>/dev/null || true; done
  rm -rf "$rundir"
}
trap cleanup EXIT INT TERM
ip link add pl-inet type bridge
ip addr add 198.20.113.1/24 dev pl-inet
ip link set pl-inet up
ip -6 addr add 2001:db8:113::1/64 dev pl-inet nodad
sysctl -q -w net.ipv6.conf.all.forwarding=1
i=0
for name in "${names[@]}"; do
  i=$((i + 1)); p=${profile[$name]}; client=pl-$name; router=pl-r$name
  ip netns add "$client"
  ip -n "$client" link set lo up
  if [[ "$p" == public ]]; then
    ip link add "pl-v$name" type veth peer name eth0 netns "$client"
    ip link set "pl-v$name" master pl-inet up
    ip -n "$client" addr add "198.20.113.$((100 + i))/24" dev eth0
    ip -n "$client" link set eth0 up
    echo "$name public 198.20.113.$((100 + i))" >> "$rundir/peers"
    continue
  fi
  wan="198.20.113.$((10 + i))"
  ip netns add "$router"
  ip link add "pl-w$name" type veth peer name wan0 netns "$router"
  ip link set "pl-w$name" master pl-inet up
  ip link add lan0 netns "$router" type veth peer name eth0 netns "$client"
  ip -n "$router" addr add "$wan/24" dev wan0; ip -n "$router" link set wan0 up
  ip -n "$router" addr add "192.168.$i.1/24" dev lan0; ip -n "$router" link set lan0 up; ip -n "$router" link set lo up
  ip -n "$client" addr add "192.168.$i.2/24" dev eth0; ip -n "$client" link set eth0 up
  ip -n "$client" route add default via "192.168.$i.1"
  ip netns exec "$router" sysctl -q -w net.ipv4.ip_forward=1
  # Unsolicited datagrams to unused WAN ports are dropped (no ICMP side channel), as on
  # typical consumer routers; replies to existing flows are handled by conntrack/NAT.
  ip netns exec "$router" iptables -A INPUT -i wan0 -p udp -j DROP
  case "$p" in
    random)
      ip netns exec "$router" iptables -t nat -A POSTROUTING -o wan0 -p udp -j SNAT --to-source "$wan:1024-65535" --random-fully
      ip netns exec "$router" iptables -t nat -A POSTROUTING -o wan0 -j SNAT --to-source "$wan" ;;
    gateonly)
      ip netns exec "$router" iptables -t nat -A POSTROUTING -o wan0 -j SNAT --to-source "$wan"
      ip netns exec "$router" iptables -P FORWARD DROP
      ip netns exec "$router" iptables -A FORWARD -p tcp -d 198.20.113.1/32 -j ACCEPT
      ip netns exec "$router" iptables -A FORWARD -p tcp -s 198.20.113.1/32 -j ACCEPT ;;
    *)
      ip netns exec "$router" iptables -t nat -A POSTROUTING -o wan0 -j SNAT --to-source "$wan" ;;
  esac
  [[ "$p" != udpblock && "$p" != v6 ]] || ip netns exec "$router" iptables -A FORWARD -p udp -j DROP
  if [[ "$p" == v6 ]]; then
    ip -n "$router" -6 addr add "2001:db8:113::$((10 + i))/64" dev wan0 nodad
    ip -n "$router" -6 addr add "2001:db8:113:$i::1/64" dev lan0 nodad
    ip -n "$client" -6 addr add "2001:db8:113:$i::2/64" dev eth0 nodad
    ip -n "$client" -6 route add default via "2001:db8:113:$i::1"
    ip -n "$router" -6 route add default via 2001:db8:113::1
    ip -6 route add "2001:db8:113:$i::/64" via "2001:db8:113::$((10 + i))" dev pl-inet
    ip netns exec "$router" sysctl -q -w net.ipv6.conf.all.forwarding=1
    # Normal stateful IPv6 firewall: outbound and replies only, no inbound permit.
    ip netns exec "$router" ip6tables -A FORWARD -i lan0 -j ACCEPT
    ip netns exec "$router" ip6tables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ip netns exec "$router" ip6tables -A FORWARD -j DROP
  fi
  if [[ "$p" == upnp ]]; then
    ip netns exec "$router" nft -f - <<EOF
table inet filter {
  chain forward { type filter hook forward priority 0; policy accept; jump miniupnpd; }
  chain miniupnpd { }
  chain prerouting { type nat hook prerouting priority -100; policy accept; jump prerouting_miniupnpd; }
  chain postrouting { type nat hook postrouting priority 100; policy accept; jump postrouting_miniupnpd; }
  chain prerouting_miniupnpd { }
  chain postrouting_miniupnpd { }
}
EOF
    cat > "$rundir/miniupnpd-$name.conf" <<EOF
ext_ifname=wan0
ext_ip=$wan
listening_ip=lan0
port=5000
enable_pcp_pmp=yes
enable_upnp=yes
secure_mode=yes
system_uptime=yes
uuid=$(cat /proc/sys/kernel/random/uuid)
upnp_table_name=filter
upnp_nat_table_name=filter
upnp_forward_chain=miniupnpd
upnp_nat_chain=prerouting_miniupnpd
upnp_nat_postrouting_chain=postrouting_miniupnpd
allow 1024-65535 192.168.0.0/16 1024-65535
deny 0-65535 0.0.0.0/0 0-65535
EOF
    ip netns exec "$router" miniupnpd -d -f "$rundir/miniupnpd-$name.conf" > "$rundir/miniupnpd-$name.log" 2>&1 &
  fi
  echo "$name $p $wan 192.168.$i.2" >> "$rundir/peers"
done
export FREEHOP_LAB_DIR="$rundir"
"$@"
