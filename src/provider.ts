export interface Identity {
    email: string;
    emailVerified: boolean;
}

/** Both AUTH_PROVIDER kinds (generic OIDC, GitHub) implement this — server.ts never branches on which one is active. */
export interface Provider {
    buildAuthUrl(redirectUri: string, state: string): string;
    exchangeCodeForIdentity(code: string, redirectUri: string): Promise<Identity>;
}
