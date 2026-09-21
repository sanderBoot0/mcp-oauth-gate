import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

/** A minimal mock OIDC IdP: serves discovery, a JWKS, and a token endpoint that mints a signed id_token — just enough for providers/oidc.ts to run against without real network calls or credentials. */
export class MockOidcIdp {
    private server?: Server;
    private privateKey?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    private kid = 'test-key-1';
    issuer = '';
    nextIdTokenClaims: Record<string, unknown> = { email: 'allowed@example.com', email_verified: true };

    async start(): Promise<void> {
        const { privateKey, publicKey } = await generateKeyPair('RS256');
        this.privateKey = privateKey;
        const jwk = await exportJWK(publicKey);

        this.server = createServer(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            res.setHeader('Content-Type', 'application/json');

            if (url.pathname === '/.well-known/openid-configuration') {
                res.end(
                    JSON.stringify({
                        issuer: this.issuer,
                        authorization_endpoint: `${this.issuer}/authorize`,
                        token_endpoint: `${this.issuer}/token`,
                        jwks_uri: `${this.issuer}/jwks`
                    })
                );
                return;
            }
            if (url.pathname === '/jwks') {
                res.end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] }));
                return;
            }
            if (url.pathname === '/token' && req.method === 'POST') {
                const idToken = await new SignJWT(this.nextIdTokenClaims)
                    .setProtectedHeader({ alg: 'RS256', kid: this.kid })
                    .setIssuer(this.issuer)
                    .setAudience('test-client-id')
                    .setExpirationTime('5m')
                    .sign(this.privateKey!);
                res.end(JSON.stringify({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not_found' }));
        });

        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        const address = this.server.address();
        if (typeof address !== 'object' || address === null) throw new Error('failed to bind mock OIDC server');
        this.issuer = `http://127.0.0.1:${address.port}`;
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.server?.close(err => (err ? reject(err) : resolve())));
    }
}
