import type { BlueskyPost } from '../types';
import { parsePostInputToAtUri } from './collections';
import { joinURIBaseAndPath, createDPOP, sha256 } from '../lib/atproto';
import { encodeBase64urlNoPadding } from '@oslojs/encoding';

class BlueskyService {
  async getProfile(actor: string): Promise<{ did: string; handle: string; displayName?: string; avatar?: string; description?: string } | null> {
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile');
      url.searchParams.set('actor', actor.replace(/^@/, ''));
      const resp = await fetch(url.toString(), { method: 'GET' });
      if (!resp.ok) return null;
      const p = await resp.json();
      return {
        did: p?.did,
        handle: p?.handle,
        displayName: p?.displayName,
        avatar: p?.avatar,
        description: p?.description,
      };
    } catch {
      return null;
    }
  }
  private async getPinnedReplyUrisPage(handle: string, cursor?: string, limit: number = 100): Promise<{ uris: string[]; cursor?: string; bookmarkTimes: Record<string, string>; }> {
    const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
    url.searchParams.set('actor', handle);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set('filter', 'posts_with_replies');
    if (cursor) url.searchParams.set('cursor', cursor);

    const resp = await fetch(url.toString(), { method: 'GET' });
    if (!resp.ok) {
      console.error('Failed to fetch author feed:', resp.status, resp.statusText);
      return { uris: [], cursor: undefined, bookmarkTimes: {} };
    }
    const data = await resp.json();
    const nextCursor: string | undefined = data?.cursor;
    const items = (data?.feed ?? []) as Array<{ post: any }>;
    const seen = new Set<string>();
    const uris: string[] = [];
    const bookmarkTimes: Record<string, string> = {};
    for (const item of items) {
      const post = item?.post;
      const text: string | undefined = post?.record?.text;
      const parentUri: string | undefined = post?.record?.reply?.parent?.uri;
      if (!text || !parentUri) continue;
      if (!text.includes('📌')) continue;
      if (!seen.has(parentUri)) {
        seen.add(parentUri);
        uris.push(parentUri);
        const createdAt: string | undefined = post?.record?.createdAt;
        if (createdAt) bookmarkTimes[parentUri] = createdAt;
      }
    }
    return { uris, cursor: nextCursor, bookmarkTimes };
  }

  async getAllPinnedReplyPostsByHandle(handle: string, limitPerPage: number = 100, maxPages: number = 1000): Promise<{ posts: BlueskyPost[]; bookmarkTimes: Record<string, string>; }> {
    const allUrisSet = new Set<string>();
    const bookmarkTimes: Record<string, string> = {};
    let cursor: string | undefined = undefined;
    for (let page = 0; page < maxPages; page++) {
      const { uris, cursor: next, bookmarkTimes: times } = await this.getPinnedReplyUrisPage(handle, cursor, limitPerPage);
      for (const u of uris) {
        allUrisSet.add(u);
      }
      Object.assign(bookmarkTimes, times);
      cursor = next;
      if (!cursor) break;
    }
    const allUris = Array.from(allUrisSet);
    const posts = await this.getPosts(allUris);
    // Sort by bookmark time desc
    posts.sort((a, b) => {
      const ta = new Date(bookmarkTimes[a.uri] ?? a.record.createdAt).getTime();
      const tb = new Date(bookmarkTimes[b.uri] ?? b.record.createdAt).getTime();
      return tb - ta;
    });
    return { posts, bookmarkTimes };
  }
  async getPinnedReplyPage(handle: string, cursor?: string, limit: number = 100): Promise<{ posts: BlueskyPost[]; cursor?: string; bookmarkTimes: Record<string, string>; }> {
    const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
    url.searchParams.set('actor', handle);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set('filter', 'posts_with_replies');
    if (cursor) url.searchParams.set('cursor', cursor);

    const resp = await fetch(url.toString(), { method: 'GET' });
    if (!resp.ok) {
      console.error('Failed to fetch author feed:', resp.status, resp.statusText);
      return { posts: [], cursor: undefined, bookmarkTimes: {} };
    }
    const data = await resp.json();
    const nextCursor: string | undefined = data?.cursor;
    const items = (data?.feed ?? []) as Array<{ post: any }>;

    const parentUris: string[] = [];
    const bookmarkTimes: Record<string, string> = {};
    const seen = new Set<string>();
    for (const item of items) {
      const post = item?.post;
      const text: string | undefined = post?.record?.text;
      const parentUri: string | undefined = post?.record?.reply?.parent?.uri;
      if (!text || !parentUri) continue; // only replies
      if (!text.includes('📌')) continue; // only our bookmark signal
      if (!seen.has(parentUri)) {
        seen.add(parentUri);
        parentUris.push(parentUri);
        const createdAt: string | undefined = post?.record?.createdAt;
        if (createdAt) bookmarkTimes[parentUri] = createdAt;
      }
    }

    if (parentUris.length === 0) {
      return { posts: [], cursor: nextCursor, bookmarkTimes };
    }

    const posts = await this.getPosts(parentUris);
    return { posts, cursor: nextCursor, bookmarkTimes };
  }

  // Post a 📌 reply to the given Bluesky URL or at:// post
  async pinByUrl(input: string): Promise<boolean> {
    try {
      const atUri = await parsePostInputToAtUri(input);
      const target = await this.getPost(atUri);
      if (!target) throw new Error('Target not found');
      const raw = sessionStorage.getItem('user_session');
      if (!raw) throw new Error('Not authenticated');
      const session = JSON.parse(raw);
      const pds = sessionStorage.getItem('user_pds');
      if (!pds) throw new Error('Missing PDS');
      // Build record for reply to root or parent; here we reply to the post itself
      // at://did/app.bsky.feed.post/<rkey>
      const parts = atUri.split('/');
  const collection = parts[3];
      if (collection !== 'app.bsky.feed.post') {
        // If target is a record embed subject; still reply with parent given by uri
      }
      const record = {
        $type: 'app.bsky.feed.post',
        text: '📌',
        createdAt: new Date().toISOString(),
        reply: {
          root: { uri: atUri, cid: target.cid },
          parent: { uri: atUri, cid: target.cid },
        },
      } as any;
      // Use repo createRecord with DPoP
      const url = joinURIBaseAndPath(pds, '/xrpc/com.atproto.repo.createRecord');
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('Accept', 'application/json');
      headers.set('Authorization', `DPoP ${session.accessJwt}`);
      // DPoP proof with 'ath' binding to access token
      const jwk = JSON.parse(sessionStorage.getItem('dpop_key_pair') || '{}');
      const privateKey = await crypto.subtle.importKey('jwk', jwk.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', jwk.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const keyPair: CryptoKeyPair = { privateKey, publicKey } as any;
      const athBytes = await sha256(new TextEncoder().encode(session.accessJwt));
      const ath = encodeBase64urlNoPadding(athBytes);
      const dpopNonce = sessionStorage.getItem('dpop_nonce') || null;
      headers.set('DPoP', await createDPOP(keyPair, 'POST', url, dpopNonce, { ath }));
      const body = { repo: session.did, collection: 'app.bsky.feed.post', record };
      let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const headerNonce = res.headers.get('DPoP-Nonce');
      if (headerNonce) sessionStorage.setItem('dpop_nonce', headerNonce);
      if (res.status === 400 || res.status === 401) {
        try {
          const data = await res.clone().json().catch(async () => ({ raw: await res.clone().text() }));
          const desc = (data?.error_description || data?.message || '').toString();
          const needsNonce = desc.includes('use_dpop_nonce') || desc.includes('nonce');
          if (needsNonce) {
            const headers2 = new Headers(headers);
            headers2.set('DPoP', await createDPOP(keyPair, 'POST', url, sessionStorage.getItem('dpop_nonce') || null, { ath }));
            res = await fetch(url, { method: 'POST', headers: headers2, body: JSON.stringify(body) });
          }
        } catch {}
      }
      if (!res.ok) return false;
      return true;
    } catch (e) {
      console.error('pinByUrl failed', e);
      return false;
    }
  }

  // Loader: list author's latest replies via AppView search (fast, CORS-friendly),
  // then fall back to /xrpc search, then author feed. Returns parent posts of replies
  // and a bookmarkTimes map (parentUri -> reply.createdAt)
  async searchPinnedReplyPage(handle: string, cursor?: string, limit: number = 50): Promise<{ posts: BlueskyPost[]; cursor?: string; bookmarkTimes: Record<string, string>; }> {
    // Helper to construct result from an array of reply-like posts
    const buildFromReplyItems = async (items: any[], nextCursor?: string) => {
      const parentUris: string[] = [];
      const bookmarkTimes: Record<string, string> = {};
      const seen = new Set<string>();
      for (const post of items) {
        const parentUri: string | undefined = post?.record?.reply?.parent?.uri;
        if (!parentUri) continue; // only replies
        if (!seen.has(parentUri)) {
          seen.add(parentUri);
          parentUris.push(parentUri);
          const createdAt: string | undefined = post?.record?.createdAt;
          if (createdAt) bookmarkTimes[parentUri] = createdAt;
        }
      }
      if (parentUris.length === 0) {
        return { posts: [] as BlueskyPost[], cursor: nextCursor, bookmarkTimes };
      }
      const posts: BlueskyPost[] = await this.getPosts(parentUris);
      posts.sort((a, b) => {
        const ta = new Date(bookmarkTimes[a.uri] ?? a.record.createdAt).getTime();
        const tb = new Date(bookmarkTimes[b.uri] ?? b.record.createdAt).getTime();
        return tb - ta;
      });
  return { posts, cursor: nextCursor, bookmarkTimes };
    };

    // First: CORS-friendly AppView search API
    try {
      const url = new URL('https://public.api.bsky.app/api/v1/app.bsky.feed.searchPosts');
      const query = `from:${handle.replace(/^@/, '')}`;
      url.searchParams.set('q', query);
      // Some gateways may expect 'query' instead of 'q'; set both defensively
      url.searchParams.set('query', query);
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
      if (cursor) url.searchParams.set('cursor', cursor);
      const resp = await fetch(url.toString(), { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const data = await resp.json();
        const nextCursor: string | undefined = data?.cursor;
        const items = (data?.posts ?? data?.records ?? []) as any[];
        return await buildFromReplyItems(items, nextCursor);
      }
      console.warn('API v1 search not available, status:', resp.status, resp.statusText);
    } catch (e) {
      console.warn('API v1 search failed:', e);
    }

    // Second: legacy /xrpc search
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
      const query = `from:${handle.replace(/^@/, '')}`;
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
      if (cursor) url.searchParams.set('cursor', cursor);
      const resp = await fetch(url.toString(), { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const data = await resp.json();
        const nextCursor: string | undefined = data?.cursor;
        const items = (data?.posts ?? []) as any[];
        return await buildFromReplyItems(items, nextCursor);
      }
      console.warn('XRPC search not available, status:', resp.status, resp.statusText);
    } catch (e) {
      console.warn('XRPC search failed:', e);
    }

    // Finally: getAuthorFeed (posts_with_replies) and keep only replies
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
      url.searchParams.set('actor', handle);
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
      url.searchParams.set('filter', 'posts_with_replies');
      if (cursor) url.searchParams.set('cursor', cursor);
      const resp = await fetch(url.toString(), { method: 'GET' });
      if (!resp.ok) {
        console.error('Failed to fetch author feed:', resp.status, resp.statusText);
        return { posts: [], cursor: undefined, bookmarkTimes: {} };
      }
      const data = await resp.json();
      const nextCursor: string | undefined = data?.cursor;
      const items = ((data?.feed ?? []) as Array<{ post: any }>).map((it) => it.post);
      return await buildFromReplyItems(items, nextCursor);
    } catch (error) {
      console.error('Error fetching author feed replies:', error);
      return { posts: [], cursor: undefined, bookmarkTimes: {} };
    }
  }

  async getPinnedReplyParentUrisByHandle(handle: string, maxPages: number = 20): Promise<string[]> {
    // Scans the author's feed via AppView and collects parent URIs of replies containing 📌
    // maxPages is a safety cap to avoid unbounded paging; 20 pages x 100 = up to ~2000 items.
    const parentUris: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = undefined;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
      url.searchParams.set('actor', handle);
      url.searchParams.set('limit', '100');
      // Fetch posts and replies; we will check reply existence below
      url.searchParams.set('filter', 'posts_with_replies');
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetch(url.toString(), { method: 'GET' });
      if (!resp.ok) break;
      const data = await resp.json();
      const items = (data.feed ?? []) as Array<{ post: any }>;
      for (const item of items) {
        const post = item?.post;
        const text: string | undefined = post?.record?.text;
        const parentUri: string | undefined = post?.record?.reply?.parent?.uri;
        if (!text || !parentUri) continue; // only replies
        if (!text.includes('📌')) continue; // only our bookmark signal
        if (!seen.has(parentUri)) {
          seen.add(parentUri);
          parentUris.push(parentUri);
        }
      }

      cursor = data?.cursor;
      if (!cursor) break; // reached end
    }

    return parentUris;
  }

  async getPost(uri: string): Promise<BlueskyPost | null> {
    try {
      // Use AppView getPosts for simplicity (public, no auth required)
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts');
      url.searchParams.append('uris', uri);
      const response = await fetch(url.toString(), { method: 'GET' });
      if (!response.ok) {
        console.error('Failed to fetch post:', response.status, response.statusText);
        return null;
      }
      const data = await response.json();
      const posts = data.posts || [];
      return posts[0] ?? null;
    } catch (error) {
      console.error('Error fetching post:', error);
      return null;
    }
  }

  async getPosts(uris: string[]): Promise<BlueskyPost[]> {
    try {
      const allPosts: BlueskyPost[] = [];
      for (let i = 0; i < uris.length; i += 25) {
        const chunk = uris.slice(i, i + 25);
        const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts');
        chunk.forEach((u) => url.searchParams.append('uris', u));
        const response = await fetch(url.toString(), { method: 'GET' });
        if (!response.ok) {
          console.error('Failed to fetch posts chunk:', response.status, response.statusText);
          continue;
        }
        const data = await response.json();
        const posts = (data.posts || []) as BlueskyPost[];
        allPosts.push(...posts);
      }
      return allPosts;
    } catch (error) {
      console.error('Error fetching posts:', error);
      return [];
    }
  }

  async searchPosts(query: string): Promise<BlueskyPost[]> {
    try {
      // Use the public AppView search endpoint; include q and limit via query params.
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '50');
      const response = await fetch(url.toString(), { method: 'GET' });
      if (!response.ok) {
        console.error('Failed to search posts:', response.status, response.statusText);
        return [];
      }
      const data = await response.json();
      return data.posts || [];
    } catch (error) {
      console.error('Error searching posts:', error);
      return [];
    }
  }
}

export const blueskyService = new BlueskyService();
