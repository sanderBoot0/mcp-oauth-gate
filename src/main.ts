import { PORT, AUTH_PROVIDER } from './env.js';
import { createApp } from './server.js';
import { githubProvider } from './providers/github.js';
import { oidcProvider, initOidcProvider } from './providers/oidc.js';

async function main(): Promise<void> {
    if (AUTH_PROVIDER === 'oidc') {
        await initOidcProvider();
    }
    const provider = AUTH_PROVIDER === 'github' ? githubProvider : oidcProvider;
    const app = createApp(provider);
    app.listen(PORT, '0.0.0.0', () => {
        console.error(`[server] mcp-oauth-gate listening on :${PORT}, provider=${AUTH_PROVIDER}`);
    });
}

main().catch(err => {
    console.error('[server] failed to start:', err);
    process.exit(1);
});
