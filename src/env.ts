function required(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback;
    if (value === undefined) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export const PORT = Number(required('PORT', '4000'));
// Public URL this gateway is reached at, e.g. https://auth.example.com
export const BASE_URL = required('BASE_URL').replace(/\/$/, '');
// The reverse proxy is expected to strip this prefix before proxying here
// (see the nginx/Traefik/Caddy examples in the README), but external URLs
// (shown to the user, registered with the identity provider) need it.
export const AUTH_PATH_PREFIX = '/auth';

// The canonical URI of the protected resource this gateway is guarding
// (RFC9728/RFC8707) — advertised in the protected-resource metadata and the
// WWW-Authenticate header. Not assumed to be this gateway's own /mcp path;
// it's whatever the downstream service's real, externally-reachable URI is.
export const RESOURCE_URL = required('RESOURCE_URL');

export type AuthProvider = 'oidc' | 'github';

function requireAuthProvider(): AuthProvider {
    const value = required('AUTH_PROVIDER');
    if (value !== 'oidc' && value !== 'github') {
        throw new Error(`AUTH_PROVIDER must be "oidc" or "github", got: ${value}`);
    }
    return value;
}

export const AUTH_PROVIDER = requireAuthProvider();

// Only required when AUTH_PROVIDER=oidc — the issuer base URL, e.g.
// https://accounts.google.com. Discovery is fetched from
// `${OIDC_ISSUER_URL}/.well-known/openid-configuration`.
export const OIDC_ISSUER_URL = AUTH_PROVIDER === 'oidc' ? required('OIDC_ISSUER_URL').replace(/\/$/, '') : '';

export const CLIENT_ID = required('CLIENT_ID');
export const CLIENT_SECRET = required('CLIENT_SECRET');

export const ALLOWED_EMAILS = required('ALLOWED_EMAILS')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

export const DB_PATH = required('DB_PATH', '/data/tokens.db');
