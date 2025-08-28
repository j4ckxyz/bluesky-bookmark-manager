import type { UserSession } from '../types';
import { createDPOP, sha256, joinURIBaseAndPath, createLocalhostATProtoOAuthClient } from '../lib/atproto';
import { encodeBase64urlNoPadding } from '@oslojs/encoding';

type ListRecord = {
  $type: 'net.anisota.feed.list';
  name: string;
  tags?: string[];
  description?: string;
  createdAt?: string;
};

type ListItemRecord = {
  $type: 'net.anisota.feed.listItem';
  list: string; // at://.../net.anisota.feed.list/<rkey>
  subject: string; // at://.../app.bsky.feed.post/<rkey>
  createdAt?: string;
};

export type AnisotaList = {
  uri: string;
  rkey: string;
  value: ListRecord;
};

export type AnisotaListItem = {
  uri: string;
  rkey: string;
  value: ListItemRecord;
};

const CACHE_KEY = 'anisota_cache_v1';

function getSession(): UserSession {
  const raw = sessionStorage.getItem('user_session');
  if (!raw) throw new Error('Not authenticated');
  return JSON.parse(raw);
}

function getPds(): string | null {
  return sessionStorage.getItem('user_pds');
}

function getCache(): any | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCache(data: any) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ...data })); } catch {}
}

export async function fetchAnisotaLists(): Promise<AnisotaList[]> {
  const cached = getCache();
  if (cached?.lists && Date.now() - cached.ts < 60_000) return cached.lists;
  const session = getSession();
  const pds = getPds();
  if (!pds) throw new Error('Missing PDS');
  // Page through all list records
  const lists: AnisotaList[] = [];
  let cursor: string | undefined = undefined;
  do {
    const params = new URLSearchParams({ repo: session.did, collection: 'net.anisota.feed.list', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await xrpc(`/xrpc/com.atproto.repo.listRecords?${params.toString()}`, { method: 'GET' });
    if (!res.ok) break;
    const j = await res.json();
    const page: AnisotaList[] = (j.records || []).map((r: any) => ({
      uri: r.uri,
      rkey: (r.uri as string).split('/').pop(),
      value: r.value,
    }));
    lists.push(...page);
    cursor = j?.cursor;
  } while (cursor);
  setCache({ ...(cached||{}), lists });
  return lists;
}

export async function fetchAnisotaListItems(listUri: string): Promise<AnisotaListItem[]> {
  const cached = getCache();
  const listKey = `items:${listUri}`;
  if (cached?.[listKey] && Date.now() - cached.ts < 60_000) return cached[listKey];
  const session = getSession();
  const pds = getPds();
  if (!pds) throw new Error('Missing PDS');
  // Enumerate ALL items via pagination, then filter by list URI. Handle list as string or strongRef object.
  const all: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const params = new URLSearchParams({ repo: session.did, collection: 'net.anisota.feed.listItem', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await xrpc(`/xrpc/com.atproto.repo.listRecords?${params.toString()}`, { method: 'GET' });
    if (!res.ok) break;
    const j = await res.json();
    all.push(...(j.records || []));
    cursor = j?.cursor;
  } while (cursor);

  const items: AnisotaListItem[] = all
    .filter((r: any) => {
      const lv = r?.value?.list;
      if (!lv) return false;
      if (typeof lv === 'string') return lv === listUri;
      if (typeof lv === 'object' && typeof lv.uri === 'string') return lv.uri === listUri;
      return false;
    })
    .map((r: any) => ({
      uri: r.uri as string,
      rkey: ((r.uri as string).split('/').pop() as string),
      value: r.value as ListItemRecord,
    }));
  const next = { ...(cached||{}), [listKey]: items };
  setCache(next);
  return items;
}

async function getDpopKeyPair(): Promise<CryptoKeyPair> {
  const raw = sessionStorage.getItem('dpop_key_pair');
  if (!raw) throw new Error('Missing DPoP key');
  const jwk = JSON.parse(raw);
  const privateKey = await crypto.subtle.importKey('jwk', jwk.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicKey = await crypto.subtle.importKey('jwk', jwk.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return { privateKey, publicKey } as CryptoKeyPair;
}

async function xrpc(path: string, init?: RequestInit & { json?: any }): Promise<Response> {
  let session = getSession();
  const pds = getPds();
  if (!pds) throw new Error('Missing PDS');
  const url = joinURIBaseAndPath(pds, path);
  const method = (init?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `DPoP ${session.accessJwt}`);
  const keyPair = await getDpopKeyPair();
  let dpopNonce: string | null = sessionStorage.getItem('dpop_nonce') || null;
  const ath = encodeBase64urlNoPadding(await sha256(new TextEncoder().encode(session.accessJwt)));
  headers.set('DPoP', await createDPOP(keyPair, method, url, dpopNonce, { ath }));
  const makeBody = () => (init?.json !== undefined ? JSON.stringify(init.json) : init?.body);
  let res = await fetch(url, { ...init, method, headers, body: makeBody() });
  const headerNonce = res.headers.get('DPoP-Nonce');
  if (headerNonce) {
    dpopNonce = headerNonce;
    sessionStorage.setItem('dpop_nonce', dpopNonce);
  }
  if (res.status === 400 || res.status === 401) {
    try {
      const data = await res.clone().json().catch(async () => ({ raw: await res.clone().text() }));
      const desc = (data?.error_description || data?.message || '').toString();
      const needsNonce = desc.includes('use_dpop_nonce') || desc.includes('nonce');
      if (needsNonce) {
        const retryHeaders = new Headers(headers);
        retryHeaders.set('DPoP', await createDPOP(keyPair, method, url, dpopNonce, { ath }));
        res = await fetch(url, { ...init, method, headers: retryHeaders, body: makeBody() });
      }
      if (res.status === 401) {
        // one-shot refresh
        const tokenEndpoint = sessionStorage.getItem('oauth_token_endpoint') || '';
        const issuer = sessionStorage.getItem('authorization_server_issuer') || '';
        const stored = sessionStorage.getItem('user_session');
        const refreshJwt = stored ? (JSON.parse(stored).refreshJwt as string) : '';
        if (tokenEndpoint && issuer && refreshJwt) {
          try {
            const origin = window.location.origin.replace('localhost', '127.0.0.1');
            const redirectUri = `${origin}/auth/callback`;
            const storedScopes = JSON.parse(sessionStorage.getItem('oauth_optional_scopes') || '[]');
            const client = createLocalhostATProtoOAuthClient(issuer, redirectUri, storedScopes);
            const body = new URLSearchParams();
            body.set('grant_type', 'refresh_token');
            body.set('client_id', (client as any).clientId || '');
            body.set('refresh_token', refreshJwt);
            body.set('resource', pds);
            const tokenReq = new Request(tokenEndpoint, { method: 'POST', body });
            tokenReq.headers.set('Content-Type', 'application/x-www-form-urlencoded');
            tokenReq.headers.set('Accept', 'application/json');
            tokenReq.headers.set('DPoP', await createDPOP(keyPair, 'POST', tokenEndpoint, sessionStorage.getItem('dpop_nonce') || null, {}));
            let tokenRes = await fetch(tokenReq, { headers: tokenReq.headers });
            if (!tokenRes.ok) {
              const nonce = tokenRes.headers.get('DPoP-Nonce');
              if (nonce) {
                sessionStorage.setItem('dpop_nonce', nonce);
                tokenReq.headers.set('DPoP', await createDPOP(keyPair, 'POST', tokenEndpoint, nonce, {}));
                tokenRes = await fetch(tokenReq, { headers: tokenReq.headers });
              }
            }
            if (tokenRes.ok) {
              const t = await tokenRes.json();
              session = { ...session, accessJwt: t.access_token, refreshJwt: t.refresh_token || (session as any).refreshJwt } as any;
              sessionStorage.setItem('user_session', JSON.stringify(session));
              const newHeaders = new Headers(init?.headers);
              if (init?.json !== undefined) newHeaders.set('Content-Type', 'application/json');
              newHeaders.set('Accept', 'application/json');
              newHeaders.set('Authorization', `DPoP ${session.accessJwt}`);
              const newAth = encodeBase64urlNoPadding(await sha256(new TextEncoder().encode(session.accessJwt)));
              newHeaders.set('DPoP', await createDPOP(keyPair, method, url, dpopNonce, { ath: newAth }));
              res = await fetch(url, { ...init, method, headers: newHeaders, body: makeBody() });
            }
          } catch {}
        }
      }
    } catch {}
  }
  return res;
}
