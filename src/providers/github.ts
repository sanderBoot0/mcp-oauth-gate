import { CLIENT_ID, CLIENT_SECRET } from '../env.js';
import type { Provider } from '../provider.js';

const AUTH_ENDPOINT = 'https://github.com/login/oauth/authorize';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

// GitHub's OAuth isn't OIDC-compliant (no id_token) so it needs its own
// REST-based identity lookup instead of the generic JWT/JWKS verification
// the OIDC provider uses.
export const githubProvider: Provider = {
    buildAuthUrl(redirectUri: string, state: string): string {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: redirectUri,
            // Needed to read the account's verified email — GitHub doesn't
            // return one from the basic profile scope.
            scope: 'read:user user:email',
            state,
            // This is a single-tenant allowlisted gateway, not a public
            // signup flow — don't let GitHub offer to create a new account.
            allow_signup: 'false'
        });
        return `${AUTH_ENDPOINT}?${params.toString()}`;
    },

    async exchangeCodeForIdentity(code: string, redirectUri: string) {
        const tokenRes = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                redirect_uri: redirectUri
            })
        });
        if (!tokenRes.ok) {
            throw new Error(`GitHub token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
        }
        const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
        if (!tokenBody.access_token) {
            throw new Error(`GitHub token exchange had no access_token: ${tokenBody.error ?? ''} ${tokenBody.error_description ?? ''}`);
        }

        const emailsRes = await fetch(EMAILS_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${tokenBody.access_token}`,
                Accept: 'application/vnd.github+json',
                // Required by GitHub's API for every request, not optional.
                'User-Agent': 'mcp-oauth-gate'
            }
        });
        if (!emailsRes.ok) {
            throw new Error(`GitHub emails lookup failed: ${emailsRes.status} ${await emailsRes.text()}`);
        }
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        const primary = emails.find(e => e.primary && e.verified);
        if (!primary) {
            throw new Error('GitHub account has no verified primary email');
        }
        return { email: primary.email.toLowerCase(), emailVerified: true };
    }
};
