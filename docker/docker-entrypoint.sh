#!/bin/sh
set -eu

: "${UPSTREAM_URL:?UPSTREAM_URL is required — the internal address of the service this gateway protects, e.g. http://mcp-server:3000 (scheme+host+port only, no path: nginx forwards the original request path unchanged)}"

case "$UPSTREAM_URL" in
    https://*)
        echo "UPSTREAM_URL must be http:// — HTTPS upstreams aren't supported yet (nginx's proxy_ssl_server_name/proxy_ssl_verify aren't configured, so an https:// value would silently skip SNI and certificate verification). Point this at the service over plain HTTP on your internal network instead." >&2
        exit 1
        ;;
    http://*) ;;
    *)
        echo "UPSTREAM_URL must start with http:// (got: $UPSTREAM_URL)" >&2
        exit 1
        ;;
esac

# Must be scheme+host+port only. nginx's variable-based proxy_pass doesn't
# ignore a path embedded here the way a literal proxy_pass does — it
# replaces the client's actual request URI outright, silently breaking
# "the original request path is forwarded unchanged" (confirmed by
# testing: a proxy_pass variable set to ".../foo" turns *every* request,
# regardless of what path the client asked for, into a request for /foo).
authority="${UPSTREAM_URL#http://}"
case "$authority" in
    */* | *'?'* | *'#'*)
        echo "UPSTREAM_URL must be scheme+host+port only, no path/query/fragment (got: $UPSTREAM_URL) — the gateway forwards the original request path unchanged, which a path here would silently override instead." >&2
        exit 1
        ;;
esac

export NODE_PORT="${PORT:-4000}"

# Works across Docker, Compose, and Kubernetes alike, unlike hardcoding
# Docker's embedded-DNS address (127.0.0.11) — whatever container runtime
# this is running under has already populated /etc/resolv.conf correctly.
RESOLVER=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)
export RESOLVER="${RESOLVER:-127.0.0.11}"

envsubst '${UPSTREAM_URL} ${NODE_PORT} ${RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Only relevant if you put another reverse proxy in front of this container
# (see docs/reverse-proxy.md) — without it, nginx's rate limiting keys off
# that proxy's address for every client, since $binary_remote_addr is
# whoever connected to nginx directly. Set it to that proxy's IP/CIDR so
# nginx trusts its X-Forwarded-For header and rate-limits per real client
# instead. Left unset (the default), nothing changes.
mkdir -p /etc/nginx/conf.d
if [ -n "${TRUSTED_PROXY_CIDR:-}" ]; then
    cat > /etc/nginx/conf.d/real-ip.conf <<CONF
set_real_ip_from ${TRUSTED_PROXY_CIDR};
real_ip_header X-Forwarded-For;
real_ip_recursive on;
CONF
else
    rm -f /etc/nginx/conf.d/real-ip.conf
fi

# Node binds to 127.0.0.1 only — nginx is the only thing in this container
# that talks to it, and it's the only thing this container exposes.
node dist/main.js &
NODE_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

# This script is PID 1, so a `docker stop` sends TERM/INT here, not to the
# background children — without forwarding it, Docker's default stop
# timeout would just SIGKILL everything with no chance for node to finish
# an in-flight request or nginx to close connections cleanly.
shutdown() {
    kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

# Portable equivalent of bash's `wait -n` (busybox ash doesn't have it):
# poll until either process has exited on its own, then bring the whole
# container down. Docker's healthcheck alone doesn't restart anything on
# failure — only a container *exit* does, via `restart: unless-stopped` or
# your orchestrator's restart policy — so leaving the other process
# running after one dies would just leave the container up and
# permanently broken. Not a full process supervisor; a two-process
# container this small doesn't need one beyond "notice a death, exit."
while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
    sleep 1
done
kill "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
exit 1
