# Security model

This document states the assumptions `mcp-oauth-gate` is built on, so you
can decide whether they hold for your deployment before relying on it.

## Core assumption: single-tenant, allowlist-gated

This is **not** a multi-tenant identity system. There is exactly one trust
boundary: a flat, operator-configured list of emails (`ALLOWED_EMAILS`).
Anyone who authenticates with the upstream identity provider *and* whose
verified email is on that list gets a token with full access to the
protected resource. There is no per-user scoping, no roles, no per-client
permissions — every allowed user can do everything the protected service
allows.

If you need per-user authorization (different users see different data or
have different permissions), this tool is the wrong layer for that — put it
in the protected service itself, or use a real multi-tenant identity
platform instead.

## Dynamic Client Registration is intentionally unauthenticated

`POST /register` (RFC7591) accepts registration from anyone, without a
token or secret, and mints a `client_id` on the spot. This is deliberate,
not an oversight:

- The actual access-control gate is the identity-provider login in
  `/oauth/callback`, checked against `ALLOWED_EMAILS` — not client
  registration. An attacker who registers a client still can't get a token
  without a verified, allowlisted email logging in through it.
- Requiring pre-shared credentials for registration would defeat the point
  of Dynamic Client Registration, which exists so MCP clients (VS Code,
  Claude Desktop, etc.) can self-register on first connect without the
  operator manually provisioning each one.
- This is a widely-used pattern for exactly this kind of single-tenant
  gateway — public client registration is safe *precisely because* the
  allowlist, not the registry, is the real gate.

This means anyone can enumerate the `/register` endpoint and accumulate
`oauth_clients` rows. That's a nuisance (unbounded row growth, no rate
limit on registration by default beyond whatever the reverse proxy
applies), not an authorization bypass. If this matters for your deployment,
add rate limiting on `/register` at the reverse-proxy layer.

## What's out of scope

- **Multi-tenancy.** See above — flat allowlist only, by design (see
  [`plan.md`](../plan.md)'s non-goals).
- **Pluggable storage.** SQLite only. A compromised or corrupted DB file is
  a full outage/reset of every issued token, not a partial one.
- **Rate limiting, WAF, DDoS protection.** These are the reverse proxy's
  job (see [`docs/reverse-proxy.md`](./reverse-proxy.md) for example
  `limit_req`/rate-limit config). The gateway itself does not throttle
  requests.
- **Auditing/logging beyond stderr.** Token issuance/revocation events are
  not shipped anywhere; `console.error` output is all there is unless you
  wire up your own log aggregation.
- **Protection against a compromised identity provider.** If the
  configured IdP itself is compromised (or its JWKS/OIDC discovery
  response is tampered with in transit — verify you're using HTTPS
  end-to-end), this gateway has no independent way to detect that; it
  trusts the IdP's assertion of the user's verified email.
- **Non-OAuth identity** (passwords, magic links, WebAuthn) — see
  `plan.md`.

## What is defended against

- **PKCE (RFC7636, S256 only)** on the authorization-code flow — a stolen
  authorization code is useless without the matching verifier.
- **Refresh-token rotation with reuse detection.** Every refresh mints a
  new refresh token and invalidates the old one. If an already-spent
  refresh token is presented again, the entire rotation chain (every
  access + refresh token descended from that login) is revoked immediately
  — the standard OAuth 2.1 response to a refresh token that looks like it
  leaked.
- **Exact-match `redirect_uri` enforcement.** `/authorize` only redirects
  to a `redirect_uri` that was registered verbatim for that `client_id` —
  no substring/prefix matching that could be abused for an open redirect.
- **CSRF protection on the identity-provider callback.** A random value is
  set as an `HttpOnly` cookie before redirecting to the IdP and checked
  against the `state` parameter on return.
- **Tokens stored hashed** (SHA-256), never in plaintext, in SQLite.
- **Short-lived OAuth access tokens** (1 hour) with 30-day refresh tokens,
  vs. non-expiring device-code tokens (no refresh mechanism exists for
  those, so they're long-lived by design — revoke them manually via
  `npm run tokens -- revoke <id>` if a device is compromised).

## Before you tag a release

Per `plan.md`'s definition of done: get at least one outside pair of eyes
on the authorization-code flow, the refresh-rotation/reuse-detection logic,
and the CSRF handling before tagging anything `v0.1.0` — this handles real
credentials and access tokens, and a second reviewer catching a logic error
here is worth far more than in most code.
