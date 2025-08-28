import type { BlueskyPost } from '../types';

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
