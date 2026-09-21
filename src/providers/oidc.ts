import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CLIENT_ID, CLIENT_SECRET, OIDC_ISSUER_URL } from '../env.js';
import type { Provider } from '../provider.js';

interface DiscoveryDocument {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
}

let discovery: DiscoveryDocument | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Fetches `${OIDC_ISSUER_URL}/.well-known/openid-configuration` — must resolve before the OIDC provider is used. Called once at server startup. */
export async function initOidcProvider(): Promise<void> {
    const res = await fetch(`${OIDC_ISSUER_URL}/.well-known/openid-configuration`);
    if (!res.ok) {
        throw new Error(`OIDC discovery failed for ${OIDC_ISSUER_URL}: ${res.status} ${await res.text()}`);
    }
    discovery = (await res.json()) as DiscoveryDocument;
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
}

function requireDiscovery(): DiscoveryDocument {
    if (!discovery) {
        throw new Error('OIDC provider used before initOidcProvider() completed');
    }
    return discovery;
}

// Covers any OIDC-compliant provider (Google, Microsoft/Azure AD, Okta,
// Auth0, Keycloak, Authentik, GitLab, ...) via discovery — one code path
// instead of N bespoke integrations. Verified via the id_token's JWT
// signature against the provider's published JWKS, not a REST call.
export const oidcProvider: Provider = {
    buildAuthUrl(redirectUri: string, state: string): string {
        const { authorization_endpoint } = requireDiscovery();
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email',
            state,
            prompt: 'select_account'
        });
        return `${authorization_endpoint}?${params.toString()}`;
    },

    async exchangeCodeForIdentity(code: string, redirectUri: string) {
        const { token_endpoint, issuer } = requireDiscovery();
        const res = await fetch(token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        if (!res.ok) {
            throw new Error(`OIDC token exchange failed: ${res.status} ${await res.text()}`);
        }
        const body = (await res.json()) as { id_token?: string };
        if (!body.id_token) {
            throw new Error('OIDC token response had no id_token');
        }
        const { payload } = await jwtVerify(body.id_token, jwks!, {
            issuer,
            audience: CLIENT_ID
        });
        if (typeof payload.email !== 'string') {
            throw new Error('OIDC id_token had no email claim');
        }
        return {
            email: payload.email.toLowerCase(),
            emailVerified: payload.email_verified === true
        };
    }
};
