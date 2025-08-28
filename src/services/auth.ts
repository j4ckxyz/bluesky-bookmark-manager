import {
  resolveATProtoHandle,
  getPDSFromAccountDID,
  getAuthorizationServer,
  getATProtoAuthorizationServerMetadata,
  createLocalhostATProtoOAuthClient,
  ATProtoOAuthClient,
} from '../lib/atproto';
import { generateOAuthNonce } from '../lib/utils';
import type { UserSession } from '../types';

class AuthService {
  private readonly redirectUri: string;
  private readonly isProdHost: boolean;

  constructor() {
    // Use 127.0.0.1 for AT Protocol localhost development compliance (RFC 8252)
    const origin = window.location.origin.replace('localhost', '127.0.0.1');
    this.redirectUri = `${origin}/auth/callback`;
    this.isProdHost = /bookmarks\.atproto\.uk$/.test(window.location.hostname);
  }

  async initiateAuth(handle: string): Promise<void> {
    try {
  if (import.meta.env.DEV) console.log(`[OAuth] Starting auth flow for handle: ${handle}`);
      
      // Step 1: Resolve handle to DID
      const normalizedHandle = handle.toLowerCase().replace(/^@/, '');
  if (import.meta.env.DEV) console.log(`[OAuth] Resolving handle: ${normalizedHandle}`);
      const did = await resolveATProtoHandle(normalizedHandle);
  if (import.meta.env.DEV) console.log(`[OAuth] Resolved DID: ${did}`);
      
      // Step 2: Get PDS endpoint from DID
      const pdsEndpoint = await getPDSFromAccountDID(did);
  if (import.meta.env.DEV) console.log(`[OAuth] PDS endpoint: ${pdsEndpoint}`);
      
      // Step 3: Get authorization server
      const authorizationServer = await getAuthorizationServer(pdsEndpoint);
  if (import.meta.env.DEV) console.log(`[OAuth] Authorization server: ${authorizationServer}`);
      
      // For development: if not bsky.social, warn about potential OAuth issues
      if (!authorizationServer.includes('bsky.social')) {
        console.warn(`[OAuth] Using non-bsky.social OAuth server: ${authorizationServer}`);
        console.warn(`[OAuth] Note: Non-bsky.social servers may have strict client ID requirements for localhost development.`);
      }
      
      // Step 4: Get authorization server metadata
    const metadata = await getATProtoAuthorizationServerMetadata(authorizationServer);
  if (import.meta.env.DEV) console.log(`[OAuth] Metadata retrieved for issuer: ${metadata.issuer}`);
  // Default read-only scopes: Bluesky AppView RPC reads + anisota repo read
  const appviewAud = 'did:web:api.bsky.app#bsky_appview';
  const optionalScopes: string[] = [
    // Bluesky AppView RPC (read-only)
    `rpc:app.bsky.actor.getProfile?aud=${encodeURIComponent(appviewAud)}`,
    `rpc:app.bsky.feed.getAuthorFeed?aud=${encodeURIComponent(appviewAud)}`,
    `rpc:app.bsky.feed.getPosts?aud=${encodeURIComponent(appviewAud)}`,
    `rpc:app.bsky.feed.searchPosts?aud=${encodeURIComponent(appviewAud)}`,
    // Anisota collections (read-only repo)
    'repo:net.anisota.feed.list?action=read',
    'repo:net.anisota.feed.listItem?action=read',
  ];
      
      // Step 5: Generate OAuth parameters
      const state = generateOAuthNonce();
      const codeVerifier = generateOAuthNonce();
      // Generate a DPoP key pair (reuse for PAR and token exchange)
      if (!window.crypto?.subtle) {
        throw new Error('Web Crypto API unavailable. Use a modern browser over http://127.0.0.1.');
      }
      const dpopKeyPair = await window.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      // Store pending DPoP key in session (JWK) for the callback
      const pendingJwk = {
        privateKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.privateKey),
        publicKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.publicKey)
      };
      sessionStorage.setItem('pending_dpop_key_pair', JSON.stringify(pendingJwk));

      // Step 6: Create OAuth client
      // If on production domain, use a static client_id pointing to hosted client-metadata.json
      // else use special localhost client_id format.
      const oauthClient = this.isProdHost
        ? new ATProtoOAuthClient(
            authorizationServer,
            'https://bookmarks.atproto.uk/oauth-client-metadata.json',
            // Use actual origin to support both prod and preview deployments if hosted under domain
            `${window.location.origin}/auth/callback`,
            null,
          )
        : createLocalhostATProtoOAuthClient(
            authorizationServer,
            this.redirectUri,
            optionalScopes
          );
      
      // Step 7: Create authorization URL using Pushed Authorization Request
      const authorizationURL = await oauthClient.createAuthorizationURL(
        metadata.pushedAuthorizationRequestEndpoint,
        metadata.authorizationEndpoint,
        state,
        codeVerifier,
        optionalScopes,
        dpopKeyPair,
        pdsEndpoint,
        normalizedHandle
      );
      
  if (import.meta.env.DEV) console.log(`[OAuth] Authorization URL created: ${authorizationURL.toString()}`);
      
      // Step 8: Store OAuth parameters in session storage
      sessionStorage.setItem('oauth_state', state);
      sessionStorage.setItem('oauth_code_verifier', codeVerifier);
      sessionStorage.setItem('oauth_handle', normalizedHandle);
      sessionStorage.setItem('oauth_did', did);
  sessionStorage.setItem('oauth_authorization_server', authorizationServer);
  sessionStorage.setItem('oauth_optional_scopes', JSON.stringify(optionalScopes));
  sessionStorage.setItem('user_pds', pdsEndpoint);
  sessionStorage.setItem('oauth_token_endpoint', metadata.tokenEndpoint);
      
      // Step 9: Redirect to authorization server
      window.location.href = authorizationURL.toString();
      
    } catch (error) {
  console.error('[OAuth] Error initiating auth:', error);
      throw error;
    }
  }

  async handleAuthCallback(code: string, state: string): Promise<UserSession> {
    try {
  if (import.meta.env.DEV) console.log('[OAuth] Handling auth callback');

      // If a session already exists, return it (guards against double invocation in dev)
      const existing = this.getStoredSession();
      if (existing) {
  if (import.meta.env.DEV) console.log('[OAuth] Existing session found; skipping duplicate callback handling');
        return existing;
      }
      
      // Verify state parameter
      const storedState = sessionStorage.getItem('oauth_state');
      if (!storedState || state !== storedState) {
        throw new Error('Invalid state parameter');
      }
      
      // Get stored OAuth parameters
      const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
      const handle = sessionStorage.getItem('oauth_handle');
      const did = sessionStorage.getItem('oauth_did');
      const authorizationServer = sessionStorage.getItem('oauth_authorization_server');
      const tokenEndpoint = sessionStorage.getItem('oauth_token_endpoint');
      
      if (!codeVerifier || !handle || !did || !authorizationServer || !tokenEndpoint) {
        throw new Error('Missing OAuth parameters from session');
      }
      
      // Import the same DPoP key pair used for PAR
      const pendingJwkRaw = sessionStorage.getItem('pending_dpop_key_pair');
      if (!pendingJwkRaw) {
        throw new Error('Missing DPoP key for token exchange');
      }
      const pendingJwk = JSON.parse(pendingJwkRaw);
      const dpopKeyPair = {
        privateKey: await window.crypto.subtle.importKey(
          'jwk',
          pendingJwk.privateKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign']
        ),
        publicKey: await window.crypto.subtle.importKey(
          'jwk',
          pendingJwk.publicKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        )
      } as CryptoKeyPair;
      
      // Create OAuth client
  const oauthClient = this.isProdHost
        ? new ATProtoOAuthClient(
            authorizationServer,
            'https://bookmarks.atproto.uk/oauth-client-metadata.json',
            `${window.location.origin}/auth/callback`,
            null,
          )
        : createLocalhostATProtoOAuthClient(
            authorizationServer,
            this.redirectUri,
    JSON.parse(sessionStorage.getItem('oauth_optional_scopes') || '[]')
          );
      
      // Exchange authorization code for tokens
  if (import.meta.env.DEV) console.log('[OAuth] Exchanging code for tokens');
      const [tokens, dpopNonce] = await oauthClient.validateAuthorizationCode(
        tokenEndpoint,
        dpopKeyPair,
        code,
        codeVerifier,
        sessionStorage.getItem('user_pds') || undefined,
      );
      
  if (import.meta.env.DEV) console.log('[OAuth] Successfully obtained tokens');
      
      // Create user session
      const session: UserSession = {
        did: tokens.did,
        handle,
        accessJwt: tokens.accessToken,
        refreshJwt: tokens.refreshToken || ''
      };
      
      // Store session and clean up OAuth parameters
      sessionStorage.setItem('user_session', JSON.stringify(session));
      
      // Store DPoP key pair and nonce for making authenticated requests
      const dpopKeyPairJWK = {
        privateKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.privateKey),
        publicKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.publicKey),
      };
      sessionStorage.setItem('dpop_key_pair', JSON.stringify(dpopKeyPairJWK));
      sessionStorage.removeItem('pending_dpop_key_pair');
      if (dpopNonce) {
        sessionStorage.setItem('dpop_nonce', dpopNonce);
      }
      sessionStorage.setItem('authorization_server_issuer', authorizationServer);
      
  this.clearOAuthSession();
      
      return session;
      
    } catch (error) {
  console.error('[OAuth] Error handling callback:', error);
      this.clearOAuthSession();
      throw error;
    }
  }

  private clearOAuthSession(): void {
    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_handle');
    sessionStorage.removeItem('oauth_did');
    sessionStorage.removeItem('oauth_authorization_server');
    sessionStorage.removeItem('oauth_token_endpoint');
  }

  // Optional: re-initiate OAuth requesting write access limited to our collections lexicon
  // This will redirect the user through the auth flow again.
  async requestWriteForCollections(handle: string): Promise<void> {
    const normalizedHandle = handle.toLowerCase().replace(/^@/, '');
    const did = await resolveATProtoHandle(normalizedHandle);
    const pdsEndpoint = await getPDSFromAccountDID(did);
    const authorizationServer = await getAuthorizationServer(pdsEndpoint);
    const metadata = await getATProtoAuthorizationServerMetadata(authorizationServer);
    const state = generateOAuthNonce();
    const codeVerifier = generateOAuthNonce();
    if (!window.crypto?.subtle) {
      throw new Error('Web Crypto API unavailable. Use a modern browser over http://127.0.0.1.');
    }
    const dpopKeyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const pendingJwk = {
      privateKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.privateKey),
      publicKey: await window.crypto.subtle.exportKey('jwk', dpopKeyPair.publicKey)
    };
    sessionStorage.setItem('pending_dpop_key_pair', JSON.stringify(pendingJwk));
    // Prefer granular repo permissions; include existing read-only scopes + write for our NSIDs
    const appviewAud = 'did:web:api.bsky.app#bsky_appview';
    const readOnly = [
      `rpc:app.bsky.actor.getProfile?aud=${encodeURIComponent(appviewAud)}`,
      `rpc:app.bsky.feed.getAuthorFeed?aud=${encodeURIComponent(appviewAud)}`,
      `rpc:app.bsky.feed.getPosts?aud=${encodeURIComponent(appviewAud)}`,
      `rpc:app.bsky.feed.searchPosts?aud=${encodeURIComponent(appviewAud)}`,
      'repo:net.anisota.feed.list?action=read',
      'repo:net.anisota.feed.listItem?action=read',
    ];
    const optionalScopes = [
      ...readOnly,
      'repo:uk.atproto.bookmark.list',
      'repo:uk.atproto.bookmark.listItem',
    ];
    const oauthClient = this.isProdHost
      ? new ATProtoOAuthClient(
          authorizationServer,
          'https://bookmarks.atproto.uk/oauth-client-metadata.json',
          `${window.location.origin}/auth/callback`,
          null,
        )
      : createLocalhostATProtoOAuthClient(
          authorizationServer,
          this.redirectUri,
          optionalScopes,
        );
    const authorizationURL = await oauthClient.createAuthorizationURL(
      metadata.pushedAuthorizationRequestEndpoint,
      metadata.authorizationEndpoint,
      state,
      codeVerifier,
      optionalScopes,
      dpopKeyPair,
      pdsEndpoint,
      normalizedHandle,
    );
    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier);
    sessionStorage.setItem('oauth_handle', normalizedHandle);
    sessionStorage.setItem('oauth_did', did);
    sessionStorage.setItem('oauth_authorization_server', authorizationServer);
    sessionStorage.setItem('oauth_optional_scopes', JSON.stringify(optionalScopes));
    sessionStorage.setItem('user_pds', pdsEndpoint);
    sessionStorage.setItem('oauth_token_endpoint', metadata.tokenEndpoint);
    window.location.href = authorizationURL.toString();
  }

  getStoredSession(): UserSession | null {
    try {
      const stored = sessionStorage.getItem('user_session');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  logout(): void {
    sessionStorage.removeItem('user_session');
    sessionStorage.removeItem('dpop_key_pair');
    sessionStorage.removeItem('dpop_nonce');
    sessionStorage.removeItem('authorization_server_issuer');
    this.clearOAuthSession();
  }
}

export const authService = new AuthService();
