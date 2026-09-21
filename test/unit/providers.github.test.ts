import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '../helpers/testEnv.js';

setTestEnv({ AUTH_PROVIDER: 'github' });

let githubProvider: typeof import('../../src/providers/github.js').githubProvider;

beforeAll(async () => {
    ({ githubProvider } = await import('../../src/providers/github.js'));
});

describe('githubProvider', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('buildAuthUrl points at GitHub with the right client_id, scope, and state', () => {
        const url = new URL(githubProvider.buildAuthUrl('https://auth.test/auth/oauth/callback', 'oauth:abc:csrf'));
        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('https://auth.test/auth/oauth/callback');
        expect(url.searchParams.get('scope')).toBe('read:user user:email');
        expect(url.searchParams.get('state')).toBe('oauth:abc:csrf');
        expect(url.searchParams.get('allow_signup')).toBe('false');
    });

    it('exchangeCodeForIdentity returns the verified primary email', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gh-token' }), { status: 200 }));
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify([
                    { email: 'secondary@example.com', primary: false, verified: true },
                    { email: 'primary@example.com', primary: true, verified: true }
                ]),
                { status: 200 }
            )
        );

        const identity = await githubProvider.exchangeCodeForIdentity('some-code', 'https://auth.test/auth/oauth/callback');
        expect(identity).toEqual({ email: 'primary@example.com', emailVerified: true });
    });

    it('throws when the account has no verified primary email', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gh-token' }), { status: 200 }));
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ email: 'unverified@example.com', primary: true, verified: false }]), { status: 200 }));

        await expect(githubProvider.exchangeCodeForIdentity('some-code', 'https://auth.test/auth/oauth/callback')).rejects.toThrow(
            /no verified primary email/
        );
    });

    it('throws when the token exchange itself fails', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

        await expect(githubProvider.exchangeCodeForIdentity('bad-code', 'https://auth.test/auth/oauth/callback')).rejects.toThrow(
            /token exchange failed/
        );
    });
});
