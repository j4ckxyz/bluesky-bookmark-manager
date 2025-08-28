import type { BlueskyPost } from '../types';

export interface BookmarksCacheData {
  posts: BlueskyPost[];
  bookmarkTimes: Record<string, string>; // postUri -> reply.createdAt
  updatedAt: number;
  version: number;
}

const VERSION = 1;

function keyFor(handle: string) {
  return `bookmark_cache:${handle.toLowerCase()}`;
}

export function getCache(handle: string): BookmarksCacheData | null {
  try {
    const raw = localStorage.getItem(keyFor(handle));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookmarksCacheData;
    if (!parsed || parsed.version !== VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setCache(handle: string, data: BookmarksCacheData) {
  try {
    localStorage.setItem(keyFor(handle), JSON.stringify({ ...data, version: VERSION, updatedAt: Date.now() }));
  } catch {
    // ignore quota errors
  }
}

export function replaceCache(handle: string, posts: BlueskyPost[], bookmarkTimes: Record<string, string>) {
  setCache(handle, { posts, bookmarkTimes, updatedAt: Date.now(), version: VERSION });
}

export function mergeIntoCache(
  handle: string,
  addPosts: BlueskyPost[],
  addTimes: Record<string, string>,
  options?: { recentObserved?: Set<string>; recentCutoffISO?: string }
) {
  const existing = getCache(handle) || { posts: [], bookmarkTimes: {}, updatedAt: 0, version: VERSION };
  const byUri = new Map<string, BlueskyPost>(existing.posts.map(p => [p.uri, p]));
  for (const p of addPosts) byUri.set(p.uri, p);
  const times = { ...existing.bookmarkTimes, ...addTimes };

  // Optional prune: remove items in the recent window that are not observed now
  if (options?.recentObserved && options.recentCutoffISO) {
    const cutoff = new Date(options.recentCutoffISO).getTime();
    for (const [uri, t] of Object.entries(times)) {
      const tt = new Date(t).getTime();
      if (tt >= cutoff && !options.recentObserved.has(uri)) {
        times[uri] = undefined as any;
        byUri.delete(uri);
      }
    }
  }

  // Clean times
  for (const [k, v] of Object.entries(times)) {
    if (v === undefined as any) delete times[k];
  }

  const mergedPosts = Array.from(byUri.values());
  setCache(handle, { posts: mergedPosts, bookmarkTimes: times, updatedAt: Date.now(), version: VERSION });
}
