#!/bin/sh
set -eu

: "${UPSTREAM_URL:?UPSTREAM_URL is required — the internal address of the service this gateway protects, e.g. http://mcp-server:3000 (scheme+host+port only, no path: nginx forwards the original request path unchanged)}"

export NODE_PORT="${PORT:-4000}"

# Works across Docker, Compose, and Kubernetes alike, unlike hardcoding
# Docker's embedded-DNS address (127.0.0.11) — whatever container runtime
# this is running under has already populated /etc/resolv.conf correctly.
RESOLVER=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)
export RESOLVER="${RESOLVER:-127.0.0.11}"

envsubst '${UPSTREAM_URL} ${NODE_PORT} ${RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Node binds to 127.0.0.1 only — nginx is the only thing in this container
# that talks to it, and it's the only thing this container exposes.
node dist/main.js &

# If node dies, nginx keeps running but every auth_request to it starts
# failing (502s), which fails the /healthz check nginx proxies through to
# it — enough for an orchestrator to notice and restart the container.
# No separate process supervisor for a two-process container this small.
exec nginx -g 'daemon off;'
