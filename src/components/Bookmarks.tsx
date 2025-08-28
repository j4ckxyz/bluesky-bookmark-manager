import { useState, useEffect, useRef, useCallback } from 'react';
import { Bookmark, LogOut, RefreshCw, Search } from 'lucide-react';
import { PostCard } from './PostCard';
import { authService } from '../services/auth';
import { blueskyService } from '../services/bluesky';
import type { BlueskyPost, UserSession } from '../types';
import { getCache, mergeIntoCache } from '../services/bookmarkCache';
// import { followCreator } from '../services/follow.ts';

interface BookmarksProps {
  session: UserSession;
  onLogout: () => void;
}

export function Bookmarks({ session, onLogout }: BookmarksProps) {
  const [bookmarks, setBookmarks] = useState<BlueskyPost[]>([]); // visible list
  const [isLoading, setIsLoading] = useState(true); // only true if no cache yet
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const bookmarkTimesRef = useRef<Record<string, string>>({});
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Local cache buffer (full, sorted), we only render a chunk at a time for snappy paint
  const allCachedRef = useRef<BlueskyPost[]>([]);
  const cacheIndexRef = useRef<number>(0); // next unread index in allCachedRef
  const CHUNK = 20;
  // Follow prompt removed to keep scopes limited to this app's lexicon only
  // const [showFollowPrompt, setShowFollowPrompt] = useState(false);
  // const [creator, setCreator] = useState<{ did: string; handle: string; displayName?: string; avatar?: string; description?: string } | null>(null);

  const sortByBookmarkTime = useCallback((arr: BlueskyPost[]) => {
    const times = bookmarkTimesRef.current;
    return arr.slice().sort((a, b) => {
      const ta = new Date(times[a.uri] ?? a.record.createdAt).getTime();
      const tb = new Date(times[b.uri] ?? b.record.createdAt).getTime();
      return tb - ta;
    });
  }, []);

  const appendFromLocalBuffer = useCallback((count: number = CHUNK) => {
    const all = allCachedRef.current;
    const start = cacheIndexRef.current;
    if (start >= all.length) return false;
    const end = Math.min(start + count, all.length);
    const nextSlice = all.slice(start, end);
    if (nextSlice.length === 0) return false;
    setBookmarks(prev => prev.length === 0 ? nextSlice : [...prev, ...nextSlice]);
    cacheIndexRef.current = end;
    return end < all.length; // whether more remains locally
  }, []);

  const hydrateFromCacheThenRefresh = useCallback(async () => {
    setError('');
    // 1) Hydrate from cache instantly (visible chunk only)
    const cached = getCache(session.handle);
    if (cached && cached.posts.length) {
      bookmarkTimesRef.current = { ...cached.bookmarkTimes };
      allCachedRef.current = sortByBookmarkTime(cached.posts);
      cacheIndexRef.current = 0;
      setIsLoading(false); // don't block UI if we have cache
      appendFromLocalBuffer(CHUNK);
    } else {
      setIsLoading(true);
    }

    // 2) Kick off a background refresh of the first page (does not block UI)
    try {
      setIsRefreshing(true);
  const { posts, cursor: next, bookmarkTimes: times } = await blueskyService.searchPinnedReplyPage(session.handle, undefined, 50);
      // Merge times, rebuild local sorted buffer, but avoid clearing what's already visible; append new items when user scrolls
      bookmarkTimesRef.current = { ...(cached?.bookmarkTimes ?? {}), ...times };
      const mergedSet = new Map<string, BlueskyPost>(allCachedRef.current.map(p => [p.uri, p]));
      for (const p of posts) mergedSet.set(p.uri, p);
      const mergedArr = Array.from(mergedSet.values());
      const sorted = sortByBookmarkTime(mergedArr);
      allCachedRef.current = sorted;
      // If nothing visible yet (no cache before), show first chunk now
      if (bookmarks.length === 0) {
        cacheIndexRef.current = 0;
        setIsLoading(false);
        appendFromLocalBuffer(CHUNK);
      }
      // Write to cache and prune a 7-day window for removed pins
      try {
        const recentCutoffISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const observed = new Set(posts.map(p => p.uri));
        mergeIntoCache(session.handle, posts, times, { recentObserved: observed, recentCutoffISO });
      } catch {}
      setCursor(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bookmarks');
    } finally {
      setIsRefreshing(false);
    }
  }, [session.handle, sortByBookmarkTime, appendFromLocalBuffer, bookmarks.length]);
  // Removed Fetch All flow; search-based paging is used instead.

  useEffect(() => {
    // Reset local buffer on session change
    allCachedRef.current = [];
    cacheIndexRef.current = 0;
    setBookmarks([]);
    setCursor(undefined);
    hydrateFromCacheThenRefresh();
  }, [session]);

  // Follow prompt removed (non-lexicon write)

  const loadMore = useCallback(async () => {
    // First, drain local buffer in CHUNKs before hitting the network
    if (appendFromLocalBuffer(CHUNK)) return;
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const { posts, cursor: next, bookmarkTimes: times } = await blueskyService.searchPinnedReplyPage(session.handle, cursor, 50);
      if (posts.length) {
        // Merge into local buffer and cache
        bookmarkTimesRef.current = { ...bookmarkTimesRef.current, ...times };
        const setMap = new Map<string, BlueskyPost>(allCachedRef.current.map(p => [p.uri, p]));
        for (const p of posts) setMap.set(p.uri, p);
        allCachedRef.current = sortByBookmarkTime(Array.from(setMap.values()));
        // Persist
        try { mergeIntoCache(session.handle, posts, times); } catch {}
        // Append next chunk to visible list
        appendFromLocalBuffer(CHUNK);
      }
      setCursor(next);
    } catch (e) {
      console.error('Failed to load more bookmarks', e);
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, isLoadingMore, session.handle, appendFromLocalBuffer, sortByBookmarkTime]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first.isIntersecting) {
        loadMore();
      }
    }, { rootMargin: '400px 0px' }); // pre-emptive load
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const filteredBookmarks = bookmarks.filter(post =>
    searchQuery === '' || 
    post.record.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    post.author.handle.toLowerCase().includes(searchQuery.toLowerCase()) ||
    post.author.displayName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleLogout = () => {
    authService.logout();
    onLogout();
  };

  // Paste-to-pin state
  const [pinInput, setPinInput] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState('');
  const [hasPostWrite, setHasPostWrite] = useState(false);
  useEffect(() => {
    try {
      const scopes: string[] = JSON.parse(sessionStorage.getItem('oauth_optional_scopes') || '[]');
      const granted = sessionStorage.getItem('oauth_granted_scope') || '';
      const s = 'app.bsky.feed.post';
      setHasPostWrite(scopes.includes(`repo:${s}`) || granted.includes(`repo:${s}`));
    } catch {}
  }, []);

  async function onPastePin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinInput.trim()) return;
    setPinError('');
    try {
      if (!hasPostWrite) {
        // Reuse collections write for now? Better: add a post-write-only auth path
        // Call a helper that requests just repo:app.bsky.feed.post
        await authService.requestWriteForCollections(session.handle); // fallback prompt
        return;
      }
      setPinBusy(true);
      const res = await blueskyService.pinByUrl(pinInput.trim());
      if (!res) throw new Error('Failed to post 📌 reply');
      setPinInput('');
      // Optionally refresh cache background (new bookmark will be included on next search page)
      hydrateFromCacheThenRefresh();
    } catch (e: any) {
      setPinError(e?.message || 'Failed to bookmark');
    } finally {
      setPinBusy(false);
    }
  }

  return (
  <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
  <header className="bg-white dark:bg-gray-900 shadow-sm border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <Bookmark className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Bluesky Bookmarks
                </h1>
                <p className="text-sm text-gray-600 dark:text-gray-300">@{session.handle}</p>
              </div>
            </div>
            
      <div className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
              <a href="/collections" className="px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800">Collections</a>
              <button
                onClick={hydrateFromCacheThenRefresh}
        disabled={isLoading || isRefreshing}
        className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Refresh bookmarks"
              >
                <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={handleLogout}
        className="flex items-center space-x-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                <LogOut className="h-4 w-4" />
                <span className="text-sm">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

  {/* Search and Stats */}
  <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
  {/* Paste-to-pin */}
  <form onSubmit={onPastePin} className="mb-4 flex items-center gap-2">
    <input
      type="url"
      inputMode="url"
      value={pinInput}
      onChange={e=>setPinInput(e.target.value)}
      placeholder="Paste a Bluesky post URL to bookmark (📌 reply)"
      className="flex-1 px-3 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    <button type="submit" disabled={pinBusy} className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50">{pinBusy?'Posting…':'Pin it'}</button>
    {!hasPostWrite && (
      <button type="button" onClick={async ()=>{ try { await authService.requestWriteForCollections(session.handle); } catch {} }} className="px-3 py-2 rounded bg-indigo-600 text-white">Enable post write</button>
    )}
  </form>
  {pinError && <div className="-mt-3 mb-3 text-sm text-red-600 dark:text-red-400">{pinError}</div>}
  <div className="flex items-center justify-between gap-3 mb-4 sm:mb-6">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bookmarks..."
              className="w-full pl-10 pr-3 sm:pr-4 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
            {filteredBookmarks.length} bookmark{filteredBookmarks.length !== 1 ? 's' : ''}
            {searchQuery && ` (filtered from ${bookmarks.length})`}
          </div>
        </div>

        <div className="mb-4 p-3 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          Post collections are public. Anyone can view them with third-party tools. <a href="/collections" className="underline">Manage collections →</a>
        </div>

        {/* Content */}
  {isLoading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-300">Loading your bookmarks...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg max-w-md mx-auto">
              <p className="text-red-600 dark:text-red-300">{error}</p>
              <button
                onClick={hydrateFromCacheThenRefresh}
                className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : filteredBookmarks.length === 0 ? (
          <div className="text-center py-12">
            <Bookmark className="h-12 w-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
            {bookmarks.length === 0 ? (
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  No bookmarks found
                </h3>
                <p className="text-gray-600 dark:text-gray-300 max-w-md mx-auto">
                  Start bookmarking posts by replying to them with the 📌 emoji.
                  Your bookmarks will appear here!
                </p>
              </div>
            ) : (
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  No results
                </h3>
                <p className="text-gray-600 dark:text-gray-300">
                  Try adjusting your search query.
                </p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {filteredBookmarks.map((post) => (
                <PostCard key={post.uri} post={post} />
              ))}
            </div>
            {/* Infinite scroll sentinel (outside the grid to ensure it's reachable) */}
            {(cursor || cacheIndexRef.current < allCachedRef.current.length) && (
              <div ref={loadMoreRef} className="py-6 text-center text-gray-500 dark:text-gray-400">
                {isLoadingMore ? 'Loading more…' : 'Scroll to load more'}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 mt-12">
        <div className="max-w-4xl mx-auto px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>Bluesky Bookmarks</p>
        </div>
      </footer>

  {/* Follow UI removed */}
    </div>
  );
}
