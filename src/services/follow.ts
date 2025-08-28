import { joinURIBaseAndPath, createDPOP, sha256, createLocalhostATProtoOAuthClient } from '../lib/atproto';
import { encodeBase64urlNoPadding } from '@oslojs/encoding';

export async function followCreator(subjectDid: string): Promise<void> {
  const sessionRaw = sessionStorage.getItem('user_session');
  if (!sessionRaw) throw new Error('Not authenticated');
  const session = JSON.parse(sessionRaw);
  // If trying to follow self, just no-op
  if (subjectDid === session.did) return;
  const pds = sessionStorage.getItem('user_pds');
  if (!pds) throw new Error('Missing PDS');

  // Prepare DPoP
  const keyRaw = sessionStorage.getItem('dpop_key_pair');
  if (!keyRaw) throw new Error('Missing DPoP key');
  const jwk = JSON.parse(keyRaw);
  const privateKey = await crypto.subtle.importKey('jwk', jwk.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicKey = await crypto.subtle.importKey('jwk', jwk.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const keyPair = { privateKey, publicKey } as CryptoKeyPair;

  const url = joinURIBaseAndPath(pds, '/xrpc/com.atproto.repo.createRecord');
  const method = 'POST';
  const body = {
    repo: session.did,
    collection: 'app.bsky.graph.follow',
    record: {
      subject: subjectDid,
      createdAt: new Date().toISOString(),
    },
  };
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `DPoP ${session.accessJwt}`);
  const ath = encodeBase64urlNoPadding(await sha256(new TextEncoder().encode(session.accessJwt)));
  const dpop = await createDPOP(keyPair, method, url, sessionStorage.getItem('dpop_nonce') || null, { ath });
  headers.set('DPoP', dpop);

  let res = await fetch(url, { method, headers, body: JSON.stringify(body) });
  // Capture potential nonce and retry if needed
  if (res.status === 400 || res.status === 401) {
    let desc = '';
    try { const j = await res.clone().json(); desc = (j?.error_description || j?.message || '').toString(); } catch {}
    const headerNonce = res.headers.get('DPoP-Nonce');
    if (desc.includes('nonce') || headerNonce) {
      const nonce = headerNonce || sessionStorage.getItem('dpop_nonce') || null;
      if (headerNonce) sessionStorage.setItem('dpop_nonce', headerNonce);
      const retryHeaders = new Headers(headers);
      const retryDPoP = await createDPOP(keyPair, method, url, nonce, { ath });
      retryHeaders.set('DPoP', retryDPoP);
      res = await fetch(url, { method, headers: retryHeaders, body: JSON.stringify(body) });
    }
    // One-shot refresh if still unauthorized
    if (res.status === 401) {
      try {
        const tokenEndpoint = sessionStorage.getItem('oauth_token_endpoint') || '';
        const issuer = sessionStorage.getItem('authorization_server_issuer') || '';
        const refreshJwt: string | undefined = session.refreshJwt;
        if (tokenEndpoint && issuer && refreshJwt) {
          const origin = window.location.origin.replace('localhost', '127.0.0.1');
          const redirectUri = `${origin}/auth/callback`;
          const client = createLocalhostATProtoOAuthClient(issuer, redirectUri, ["transition:generic"]);
          const tokenBody = new URLSearchParams();
          tokenBody.set('grant_type', 'refresh_token');
          tokenBody.set('client_id', (client as any).clientId || '');
          tokenBody.set('refresh_token', refreshJwt);
          tokenBody.set('resource', pds);
          const tokenReq = new Request(tokenEndpoint, { method: 'POST', body: tokenBody });
          tokenReq.headers.set('Content-Type', 'application/x-www-form-urlencoded');
          tokenReq.headers.set('Accept', 'application/json');
          // DPoP for token request (no ath)
          const tokenDPoP = await createDPOP(keyPair, 'POST', tokenEndpoint, sessionStorage.getItem('dpop_nonce') || null, {});
          tokenReq.headers.set('DPoP', tokenDPoP);
          let tokenRes = await fetch(tokenReq);
          if (!tokenRes.ok) {
            const n = tokenRes.headers.get('DPoP-Nonce');
            if (n) {
              sessionStorage.setItem('dpop_nonce', n);
              const d = await createDPOP(keyPair, 'POST', tokenEndpoint, n, {});
              tokenReq.headers.set('DPoP', d);
              tokenRes = await fetch(tokenReq);
            }
          }
          if (tokenRes.ok) {
            const t = await tokenRes.json();
            // Update session
            const updated = { ...session, accessJwt: t.access_token, refreshJwt: t.refresh_token || session.refreshJwt };
            sessionStorage.setItem('user_session', JSON.stringify(updated));
            // Rebuild headers with new token and ath
            const newHeaders = new Headers();
            newHeaders.set('Content-Type', 'application/json');
            newHeaders.set('Accept', 'application/json');
            newHeaders.set('Authorization', `DPoP ${updated.accessJwt}`);
            const newAth = encodeBase64urlNoPadding(await sha256(new TextEncoder().encode(updated.accessJwt)));
            const newDpop = await createDPOP(keyPair, method, url, sessionStorage.getItem('dpop_nonce') || null, { ath: newAth });
            newHeaders.set('DPoP', newDpop);
            res = await fetch(url, { method, headers: newHeaders, body: JSON.stringify(body) });
          }
        }
      } catch {}
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to follow: ${res.status} ${text}`);
  }
}
