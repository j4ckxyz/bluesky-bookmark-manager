import { useState, useEffect, useRef, useCallback } from 'react';
import { Bookmark, LogOut, RefreshCw, Search, Diff } from 'lucide-react';
import { PostCard } from './PostCard';
import { authService } from '../services/auth';
import { blueskyService } from '../services/bluesky';
import type { BlueskyPost, UserSession } from '../types';
import { getCache, mergeIntoCache, replaceCache } from '../services/bookmarkCache';
import { followCreator } from '../services/follow.ts';

interface BookmarksProps {
  session: UserSession;
  onLogout: () => void;
}

export function Bookmarks({ session, onLogout }: BookmarksProps) {
  const [bookmarks, setBookmarks] = useState<BlueskyPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const bookmarkTimesRef = useRef<Record<string, string>>({});
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [isFetchingAll, setIsFetchingAll] = useState(false);
  const [showFollowPrompt, setShowFollowPrompt] = useState(false);
  const [creator, setCreator] = useState<{ did: string; handle: string; displayName?: string; avatar?: string; description?: string } | null>(null);

  const loadBookmarks = async () => {
    setIsLoading(true);
    setError('');

    try {
      // 1) Hydrate from cache immediately if available
      const cached = getCache(session.handle);
      if (cached && cached.posts.length) {
        bookmarkTimesRef.current = { ...cached.bookmarkTimes };
        const sorted = cached.posts.slice().sort((a, b) => {
          const ta = new Date(bookmarkTimesRef.current[a.uri] ?? a.record.createdAt).getTime();
          const tb = new Date(bookmarkTimesRef.current[b.uri] ?? b.record.createdAt).getTime();
          return tb - ta;
        });
        setBookmarks(sorted);
      }
      // First page of results
  const { posts, cursor: next, bookmarkTimes: times } = await blueskyService.getPinnedReplyPage(session.handle, undefined, 100);
  bookmarkTimesRef.current = { ...(cached?.bookmarkTimes ?? {}), ...times };
  // state not needed; ref drives sorting
      // Sort by bookmark time desc (most recent first)
      const sorted = posts.slice().sort((a, b) => {
        const ta = new Date(bookmarkTimesRef.current[a.uri] ?? a.record.createdAt).getTime();
        const tb = new Date(bookmarkTimesRef.current[b.uri] ?? b.record.createdAt).getTime();
        return tb - ta;
      });
      setBookmarks(sorted);
      // Merge fresh page into cache and prune recent window (last 7 days) for removed pins
      try {
        const recentCutoffISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const observed = new Set(posts.map(p => p.uri));
        mergeIntoCache(session.handle, posts, times, { recentObserved: observed, recentCutoffISO });
      } catch {}
      setCursor(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bookmarks');
    } finally {
      setIsLoading(false);
    }
  };
  const fetchAll = async () => {
    if (isFetchingAll) return;
    setIsFetchingAll(true);
    setError('');
    try {
  const { posts, bookmarkTimes: times } = await blueskyService.getAllPinnedReplyPostsByHandle(session.handle, 100, 2000);
  bookmarkTimesRef.current = { ...times };
      setBookmarks(posts);
  // Replace cache completely with full set
  try { replaceCache(session.handle, posts, times); } catch {}
      setCursor(undefined); // fully loaded
    } catch (e) {
      console.error('Failed to fetch all bookmarks', e);
      setError('Failed to fetch all bookmarks');
    } finally {
      setIsFetchingAll(false);
    }
  };

  useEffect(() => {
    loadBookmarks();
  }, [session]);

  // One-time follow prompt on first login per browser
  useEffect(() => {
    const dismissed = localStorage.getItem('follow_prompt_dismissed');
    if (dismissed === '1') return;
    (async () => {
      const p = await blueskyService.getProfile('j4ck.xyz');
      if (p?.did) {
        setCreator(p);
        setShowFollowPrompt(true);
      }
    })();
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const { posts, cursor: next, bookmarkTimes: times } = await blueskyService.getPinnedReplyPage(session.handle, cursor, 100);
      if (posts.length) {
        const existing = new Set(bookmarks.map(p => p.uri));
        const merged = [...bookmarks, ...posts.filter(p => !existing.has(p.uri))];
        // Merge bookmarkTimes (using ref to avoid stale closure)
        const newTimes = { ...bookmarkTimesRef.current, ...times };
        bookmarkTimesRef.current = newTimes;
        // Re-sort by bookmark time desc
        const sorted = merged.slice().sort((a, b) => {
          const ta = new Date(newTimes[a.uri] ?? a.record.createdAt).getTime();
          const tb = new Date(newTimes[b.uri] ?? b.record.createdAt).getTime();
          return tb - ta;
        });
        setBookmarks(sorted);
        // Append page to cache
        try { mergeIntoCache(session.handle, posts, times); } catch {}
      }
      setCursor(next);
    } catch (e) {
      console.error('Failed to load more bookmarks', e);
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, isLoadingMore, session.handle, bookmarks]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first.isIntersecting) {
        loadMore();
      }
    });
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
                onClick={loadBookmarks}
                disabled={isLoading}
        className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Refresh bookmarks"
              >
                <RefreshCw className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={fetchAll}
                disabled={isFetchingAll}
        className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Fetch all"
                aria-label="Fetch all"
              >
                <Diff className={`h-5 w-5 ${isFetchingAll ? 'animate-bounce' : ''}`} />
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
                onClick={loadBookmarks}
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
            {cursor && (
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

      {/* Follow Prompt Modal */}
      {showFollowPrompt && creator && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 backdrop-blur-sm bg-black/40" onClick={() => { localStorage.setItem('follow_prompt_dismissed','1'); setShowFollowPrompt(false); }} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
              <div className="p-5 sm:p-6">
                <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 mb-3">Follow the creator?</h2>
                <div className="flex items-center gap-4">
                  <img src={creator.avatar || '/favicon.svg'} alt="avatar" className="h-14 w-14 rounded-full object-cover border border-gray-200 dark:border-gray-800" />
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">{creator.displayName || '@'+creator.handle}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400 truncate">@{creator.handle}</div>
                  </div>
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">This helps support the app and makes it easy to reach the creator (@j4ck.xyz) for updates.</p>
                {creator.description && (
                  <p className="mt-4 text-sm text-gray-700 dark:text-gray-300 max-h-40 overflow-y-auto">{creator.description}</p>
                )}
                <div className="mt-6 flex items-center justify-end gap-3">
                  <button
                    onClick={() => { localStorage.setItem('follow_prompt_dismissed','1'); setShowFollowPrompt(false); }}
                    className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    Not now
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await followCreator(creator.did);
                      } finally {
                        localStorage.setItem('follow_prompt_dismissed','1');
                        setShowFollowPrompt(false);
                      }
                    }}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Follow @j4ck.xyz
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
