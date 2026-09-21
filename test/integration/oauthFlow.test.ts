import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setTestEnv } from '../helpers/testEnv.js';

setTestEnv();

let app: import('express').Express;

beforeAll(async () => {
    const { createApp } = await import('../../src/server.js');
    const stubProvider: import('../../src/provider.js').Provider = {
        buildAuthUrl: (_redirectUri, state) => `https://idp.test/authorize?state=${encodeURIComponent(state)}`,
        exchangeCodeForIdentity: async () => ({ email: 'allowed@example.com', emailVerified: true })
    };
    app = createApp(stubProvider);
});

function pkcePair() {
    const verifier = 'test-verifier-'.padEnd(43, 'x');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** Drives /register -> /authorize -> (simulated provider callback) -> /oauth/callback -> /token, returning the issued token pair plus enough state to drive a refresh. */
async function completeAuthorizationCodeFlow(app: import('express').Express) {
    const redirectUri = 'https://mcp-client.test/callback';
    const registerRes = await request(app).post('/register').send({ redirect_uris: [redirectUri] }).expect(201);
    const clientId = registerRes.body.client_id as string;

    const { verifier, challenge } = pkcePair();
    const authorizeRes = await request(app)
        .get('/authorize')
        .query({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'client-state-1'
        })
        .expect(302);

    const idpLocation = new URL(authorizeRes.headers.location);
    const oauthState = idpLocation.searchParams.get('state')!; // "oauth:<authId>:<csrf>"
    const csrf = oauthState.split(':')[2];
    const csrfCookie = authorizeRes.headers['set-cookie'][0];
    expect(csrfCookie).toContain(`mog_csrf=${csrf}`);

    const callbackRes = await request(app)
        .get('/oauth/callback')
        .query({ code: 'provider-code', state: oauthState })
        .set('Cookie', csrfCookie)
        .expect(302);

    const clientRedirect = new URL(callbackRes.headers.location);
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(redirectUri);
    expect(clientRedirect.searchParams.get('state')).toBe('client-state-1');
    const code = clientRedirect.searchParams.get('code')!;

    const tokenRes = await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })
        .expect(200);

    return { clientId, redirectUri, tokens: tokenRes.body as { access_token: string; refresh_token: string } };
}

describe('full OAuth 2.1 chain: register -> authorize -> token -> verify -> refresh -> reuse-detected', () => {
    it('rejects registration with no redirect_uris', async () => {
        await request(app).post('/register').send({}).expect(400).expect(res => {
            expect(res.body.error).toBe('invalid_client_metadata');
        });
    });

    it('rejects /authorize for an unregistered redirect_uri (exact-match enforcement)', async () => {
        const registerRes = await request(app).post('/register').send({ redirect_uris: ['https://mcp-client.test/cb'] }).expect(201);
        await request(app)
            .get('/authorize')
            .query({
                client_id: registerRes.body.client_id,
                redirect_uri: 'https://attacker.test/cb',
                response_type: 'code',
                code_challenge: 'x',
                code_challenge_method: 'S256'
            })
            .expect(400);
    });

    it('runs the full chain: a fresh login mints tokens that verify, refresh rotates them, and reusing a spent refresh token kills the whole family', async () => {
        const { clientId, tokens } = await completeAuthorizationCodeFlow(app);

        await request(app).get('/verify').set('Authorization', `Bearer ${tokens.access_token}`).expect(200);

        // Legitimate rotation: exchange the refresh token once.
        const refreshRes = await request(app)
            .post('/token')
            .type('form')
            .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
            .expect(200);
        const rotated = refreshRes.body as { access_token: string; refresh_token: string };
        expect(rotated.access_token).not.toBe(tokens.access_token);
        expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

        await request(app).get('/verify').set('Authorization', `Bearer ${rotated.access_token}`).expect(200);

        // Reuse of the already-consumed original refresh token — the whole chain is spent, so this must fail...
        await request(app)
            .post('/token')
            .type('form')
            .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
            .expect(400)
            .expect(res => expect(res.body.error).toBe('invalid_grant'));

        // ...and it must have revoked the *entire* family, including the access token minted by the legitimate rotation.
        await request(app).get('/verify').set('Authorization', `Bearer ${rotated.access_token}`).expect(401);
    });

    it('/verify advertises the protected-resource metadata URL on 401', async () => {
        const res = await request(app).get('/verify').expect(401);
        expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    });
});
