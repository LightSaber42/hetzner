#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/configure_hetzner_ipv6.sh <ipv6/prefix> <gateway> [iface]" >&2
  exit 1
fi

IPV6_CIDR="${1:-}"
GATEWAY="${2:-}"
IFACE="${3:-eth0}"
NETPLAN_FILE="/etc/netplan/60-hetzner-ipv6.yaml"

if [[ -z "${IPV6_CIDR}" || -z "${GATEWAY}" ]]; then
  echo "Usage: sudo bash scripts/configure_hetzner_ipv6.sh <ipv6/prefix> <gateway> [iface]" >&2
  echo "Example: sudo bash scripts/configure_hetzner_ipv6.sh '2a01:4f9:c013:d106::1/64' 'fe80::1'" >&2
  exit 1
fi

cp /etc/netplan/50-cloud-init.yaml /etc/netplan/50-cloud-init.yaml.bak 2>/dev/null || true
cp /etc/netplan/01-netcfg.yaml /etc/netplan/01-netcfg.yaml.bak 2>/dev/null || true
cp "${NETPLAN_FILE}" "${NETPLAN_FILE}.bak" 2>/dev/null || true

cat > "${NETPLAN_FILE}" <<NETPLAN
network:
  version: 2
  ethernets:
    ${IFACE}:
      dhcp4: true
      addresses:
        - ${IPV6_CIDR}
      routes:
        - to: default
          via: ${GATEWAY}
          on-link: true
      nameservers:
        addresses:
          - 2606:4700:4700::1111
          - 2001:4860:4860::8888
NETPLAN

netplan generate
netplan apply
ip -6 addr show dev "${IFACE}"
ip -6 route
ping -6 -c 3 2606:4700:4700::1111
