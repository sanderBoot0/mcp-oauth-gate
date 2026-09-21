import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTestEnv } from '../helpers/testEnv.js';
import { MockOidcIdp } from '../helpers/mockOidc.js';

const idp = new MockOidcIdp();
await idp.start();
setTestEnv({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER_URL: idp.issuer });

let oidcProvider: typeof import('../../src/providers/oidc.js').oidcProvider;
let initOidcProvider: typeof import('../../src/providers/oidc.js').initOidcProvider;

beforeAll(async () => {
    ({ oidcProvider, initOidcProvider } = await import('../../src/providers/oidc.js'));
    await initOidcProvider();
});

afterAll(async () => {
    await idp.stop();
});

describe('oidcProvider (generic OIDC discovery)', () => {
    it('buildAuthUrl uses the discovered authorization_endpoint', () => {
        const url = new URL(oidcProvider.buildAuthUrl('https://auth.test/auth/oauth/callback', 'oauth:abc:csrf'));
        expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('scope')).toBe('openid email');
        expect(url.searchParams.get('state')).toBe('oauth:abc:csrf');
    });

    it('exchangeCodeForIdentity verifies the id_token against the discovered JWKS and extracts the email', async () => {
        idp.nextIdTokenClaims = { email: 'someone@example.com', email_verified: true };
        const identity = await oidcProvider.exchangeCodeForIdentity('some-code', 'https://auth.test/auth/oauth/callback');
        expect(identity).toEqual({ email: 'someone@example.com', emailVerified: true });
    });

    it('lowercases the email and reflects email_verified: false through', async () => {
        idp.nextIdTokenClaims = { email: 'Mixed.Case@Example.com', email_verified: false };
        const identity = await oidcProvider.exchangeCodeForIdentity('some-code', 'https://auth.test/auth/oauth/callback');
        expect(identity).toEqual({ email: 'mixed.case@example.com', emailVerified: false });
    });

    it('rejects an id_token with no email claim', async () => {
        idp.nextIdTokenClaims = { sub: 'user-123' };
        await expect(oidcProvider.exchangeCodeForIdentity('some-code', 'https://auth.test/auth/oauth/callback')).rejects.toThrow(
            /no email claim/
        );
    });
});
