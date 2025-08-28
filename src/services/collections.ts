import { getPDSFromAccountDID, joinURIBaseAndPath, createDPOP, sha256, createLocalhostATProtoOAuthClient } from '../lib/atproto';
import { encodeBase64urlNoPadding } from '@oslojs/encoding';
import type { UserSession } from '../types';

export interface PostCollectionRecord {
  $type?: string;
  name: string;
  color: string; // e.g., #ff9900 or tailwind token
}

export interface PostCollection {
  uri: string; // at://did/uk.atproto.bookmark.list/<rkey>
  cid: string;
  rkey: string;
  value: PostCollectionRecord;
}

export interface PostCollectionListItemRecord {
  $type?: string;
  list: string | { uri: string; cid?: string };
  subject: string; // at:// post URI
  createdAt?: string;
}

export interface PostCollectionListItem {
  uri: string; // at://did/uk.atproto.bookmark.listItem/<rkey>
  rkey: string;
  value: PostCollectionListItemRecord;
}

const COLLECTION_NSID = 'uk.atproto.bookmark.list';
const COLLECTION_ITEM_NSID = 'uk.atproto.bookmark.listItem';
let cache: { ts: number; data: PostCollection[] } | null = null;
const CACHE_TTL_MS = 30_000; // 30s to avoid spamming PDS

async function getSession(): Promise<UserSession> {
  const raw = sessionStorage.getItem('user_session');
  if (!raw) throw new Error('Not authenticated');
  return JSON.parse(raw);
}

async function getPdsEndpoint(): Promise<string> {
  const cached = sessionStorage.getItem('user_pds');
  if (cached) return cached;
  const session = await getSession();
  const pds = await getPDSFromAccountDID(session.did);
  sessionStorage.setItem('user_pds', pds);
  return pds;
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
  let session = await getSession();
  const pds = await getPdsEndpoint();
  const url = joinURIBaseAndPath(pds, path);
  const method = (init?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `DPoP ${session.accessJwt}`);
  const keyPair = await getDpopKeyPair();
  let dpopNonce: string | null = sessionStorage.getItem('dpop_nonce') || null;
  // Include 'ath' (hash of access token) per RFC 9449 for resource access
  const athBytes = await sha256(new TextEncoder().encode(session.accessJwt));
  const ath = encodeBase64urlNoPadding(athBytes);
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
      if (res.status === 401) {
        console.error('[XRPC] 401 from PDS', { url, desc, body: data, resource: pds });
      }
      const needsNonce = desc.includes('use_dpop_nonce') || desc.includes('nonce');
      if (needsNonce) {
  const retryHeaders = new Headers(headers);
  retryHeaders.set('DPoP', await createDPOP(keyPair, method, url, dpopNonce, { ath }));
        res = await fetch(url, { ...init, method, headers: retryHeaders, body: makeBody() });
      }
      if (res.status === 401) {
        // One-shot refresh with resource targeting this PDS
        const tokenEndpoint = sessionStorage.getItem('oauth_token_endpoint') || '';
        const issuer = sessionStorage.getItem('authorization_server_issuer') || '';
        const stored = sessionStorage.getItem('user_session');
        const refreshJwt = stored ? (JSON.parse(stored).refreshJwt as string) : '';
        if (tokenEndpoint && issuer && refreshJwt) {
          try {
            const origin = window.location.origin.replace('localhost', '127.0.0.1');
            const redirectUri = `${origin}/auth/callback`;
            const client = createLocalhostATProtoOAuthClient(issuer, redirectUri, ["transition:generic"]);
            const body = new URLSearchParams();
            body.set('grant_type', 'refresh_token');
            body.set('client_id', (client as any).clientId || '');
            body.set('refresh_token', refreshJwt);
            body.set('resource', pds);
            const tokenReq = new Request(tokenEndpoint, { method: 'POST', body });
            tokenReq.headers.set('Content-Type', 'application/x-www-form-urlencoded');
            tokenReq.headers.set('Accept', 'application/json');
            // DPoP for token call (no ath for token endpoint)
            let tokenDpop = await createDPOP(keyPair, 'POST', tokenEndpoint, sessionStorage.getItem('dpop_nonce') || null, {});
            tokenReq.headers.set('DPoP', tokenDpop);
            let tokenRes = await fetch(tokenReq, { headers: tokenReq.headers });
            if (!tokenRes.ok) {
              // Try once with nonce if provided
              const nonce = tokenRes.headers.get('DPoP-Nonce');
              if (nonce) {
                sessionStorage.setItem('dpop_nonce', nonce);
                const d = await createDPOP(keyPair, 'POST', tokenEndpoint, nonce, {});
                tokenReq.headers.set('DPoP', d);
                tokenRes = await fetch(tokenReq, { headers: tokenReq.headers });
              }
            }
            if (tokenRes.ok) {
              const t = await tokenRes.json();
              // Update session with new tokens
              session = { ...session, accessJwt: t.access_token, refreshJwt: t.refresh_token || session.refreshJwt } as any;
              sessionStorage.setItem('user_session', JSON.stringify(session));
              // Rebuild auth and DPoP (with new ath)
              const newHeaders = new Headers(init?.headers);
              if (init?.json !== undefined) newHeaders.set('Content-Type', 'application/json');
              newHeaders.set('Accept', 'application/json');
              newHeaders.set('Authorization', `DPoP ${session.accessJwt}`);
              const newAth = encodeBase64urlNoPadding(await sha256(new TextEncoder().encode(session.accessJwt)));
              newHeaders.set('DPoP', await createDPOP(keyPair, method, url, dpopNonce, { ath: newAth }));
              res = await fetch(url, { ...init, method, headers: newHeaders, body: makeBody() });
            }
          } catch {
            // ignore refresh failures; will return original 401 below
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return res;
}

function parseCollectionFromRecord(rec: any): PostCollection | null {
  if (!rec?.uri || !rec?.cid || !rec?.value) return null;
  const uri: string = rec.uri;
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];
  return {
    uri,
    cid: rec.cid,
    rkey,
    value: rec.value as PostCollectionRecord,
  };
}

export async function listCollections(): Promise<PostCollection[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }
  const session = await getSession();
  const params = new URLSearchParams({ repo: session.did, collection: COLLECTION_NSID, limit: '100' });
  const res = await xrpc(`/xrpc/com.atproto.repo.listRecords?${params.toString()}`, { method: 'GET' });
  if (!res.ok) throw new Error('Failed to list collections');
  const json = await res.json();
  const records = (json?.records || []) as any[];
  const data = records.map(parseCollectionFromRecord).filter(Boolean) as PostCollection[];
  cache = { ts: Date.now(), data };
  return data;
}

export async function createCollection(name: string, color: string): Promise<PostCollection> {
  const session = await getSession();
  const record: PostCollectionRecord = { $type: COLLECTION_NSID, name, color };
  const res = await xrpc(`/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    json: { repo: session.did, collection: COLLECTION_NSID, record },
  });
  if (!res.ok) throw new Error('Failed to create collection');
  const json = await res.json();
  const uri = json?.uri as string;
  const cid = json?.cid as string;
  cache = null; // invalidate cache
  return { uri, cid, rkey: uri.split('/').pop()!, value: record };
}

export async function getCollection(uri: string): Promise<PostCollection> {
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];
  const session = await getSession();
  const params = new URLSearchParams({ repo: session.did, collection: COLLECTION_NSID, rkey });
  const res = await xrpc(`/xrpc/com.atproto.repo.getRecord?${params.toString()}`, { method: 'GET' });
  if (!res.ok) throw new Error('Failed to get collection');
  const json = await res.json();
  return parseCollectionFromRecord(json as any)!;
}

export async function updateCollection(uri: string, value: PostCollectionRecord, expectedCid?: string): Promise<PostCollection> {
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];
  const session = await getSession();
  const body: any = { repo: session.did, collection: COLLECTION_NSID, rkey, record: value };
  if (expectedCid) body.swapRecord = expectedCid;
  const res = await xrpc(`/xrpc/com.atproto.repo.putRecord`, { method: 'POST', json: body });
  if (!res.ok) throw new Error('Failed to update collection');
  const json = await res.json();
  const cid = json?.cid as string;
  cache = null; // invalidate cache
  return { uri, cid, rkey, value };
}

export async function listCollectionItems(collectionUri: string): Promise<PostCollectionListItem[]> {
  const session = await getSession();
  const items: PostCollectionListItem[] = [];
  let cursor: string | undefined = undefined;
  do {
    const params = new URLSearchParams({ repo: session.did, collection: COLLECTION_ITEM_NSID, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await xrpc(`/xrpc/com.atproto.repo.listRecords?${params.toString()}`, { method: 'GET' });
    if (!res.ok) break;
    const j = await res.json();
    const page = (j.records || []) as any[];
    for (const r of page) {
      const lv = r?.value?.list;
      const listUri = typeof lv === 'string' ? lv : (lv && typeof lv.uri === 'string' ? lv.uri : null);
      if (listUri === collectionUri) {
        items.push({ uri: r.uri as string, rkey: (r.uri as string).split('/').pop() as string, value: r.value as PostCollectionListItemRecord });
      }
    }
    cursor = j?.cursor;
  } while (cursor);
  return items;
}

export async function addPostToCollection(collectionUri: string, postUri: string): Promise<PostCollectionListItem> {
  const session = await getSession();
  const record: PostCollectionListItemRecord = { $type: COLLECTION_ITEM_NSID, list: collectionUri, subject: postUri, createdAt: new Date().toISOString() };
  const res = await xrpc(`/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    json: { repo: session.did, collection: COLLECTION_ITEM_NSID, record },
  });
  if (!res.ok) throw new Error('Failed to add item');
  const json = await res.json();
  const uri = json?.uri as string;
  return { uri, rkey: uri.split('/').pop() as string, value: record };
}

export async function removePostFromCollection(collectionUri: string, postUri: string): Promise<void> {
  const session = await getSession();
  // Find existing matching item(s)
  const items = await listCollectionItems(collectionUri);
  const matches = items.filter(it => it.value.subject === postUri);
  for (const it of matches) {
    await xrpc(`/xrpc/com.atproto.repo.deleteRecord`, {
      method: 'POST',
      json: { repo: session.did, collection: COLLECTION_ITEM_NSID, rkey: it.rkey },
    });
  }
}

export function collectionDisplay(col: PostCollection): string {
  return `${col.value.name}`;
}

export async function parsePostInputToAtUri(input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.startsWith('at://')) return trimmed;
  try {
    const u = new URL(trimmed);
    // Expect: https://bsky.app/profile/{handleOrDid}/post/{rkey}
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => p === 'profile');
    if (idx >= 0 && parts[idx+1] && parts[idx+2] === 'post' && parts[idx+3]) {
      const ident = parts[idx+1];
      const rkey = parts[idx+3];
      let did = ident;
      if (!did.startsWith('did:')) {
        // resolve handle to did
        const res = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(ident)}`);
        if (!res.ok) throw new Error('Failed to resolve handle');
        const j = await res.json();
        did = j?.did || ident;
      }
      return `at://${did}/app.bsky.feed.post/${rkey}`;
    }
  } catch {}
  throw new Error('Enter a valid at:// URI or Bluesky post URL');
}
