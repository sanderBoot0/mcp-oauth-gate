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
    // Loopback only — nginx (bundled in the same container) is the only
    // thing that talks to this directly; nothing outside the container
    // should ever reach this port.
    app.listen(PORT, '127.0.0.1', () => {
        console.error(`[server] mcp-oauth-gate listening on 127.0.0.1:${PORT}, provider=${AUTH_PROVIDER}`);
    });
}

main().catch(err => {
    console.error('[server] failed to start:', err);
    process.exit(1);
});
