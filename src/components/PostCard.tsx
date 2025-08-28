import { ExternalLink, Heart, MessageCircle, Repeat2, Play, Plus } from 'lucide-react';
import type { BlueskyPost } from '../types';
import { listCollections, addPostToCollection, createCollection, type PostCollection } from '../services/collections';
import { authService } from '../services/auth';
import { useEffect, useState } from 'react';

interface PostCardProps {
  post: BlueskyPost;
}

export function PostCard({ post }: PostCardProps) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [collections, setCollections] = useState<PostCollection[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#3b82f6');
  const [newErr, setNewErr] = useState('');
  const [hasWrite, setHasWrite] = useState(false);
  const [handle, setHandle] = useState<string>('');

  useEffect(() => {
    // prefetch lightly; do not spam PDS
    listCollections().then(setCollections).catch(()=>{});
    try {
      const sess = authService.getStoredSession();
      if (sess?.handle) setHandle(sess.handle);
      const opt = JSON.parse(sessionStorage.getItem('oauth_optional_scopes') || '[]') as string[];
      const granted = (sessionStorage.getItem('oauth_granted_scope') || '') as string;
  const needA = 'repo:uk.atproto.bookmark.list';
  const needB = 'repo:uk.atproto.bookmark.listItem';
  const has = (arr: string[]) => arr.includes(needA) && arr.includes(needB);
  setHasWrite(has(opt) || (granted.includes(needA) && granted.includes(needB)));
    } catch {}
  }, []);

  async function onAddTo(colUri: string) {
    try {
      await addPostToCollection(colUri, post.uri);
      setChooserOpen(false);
    } catch (e) {
      // swallow for now; could toast
    }
  }

  async function onCreateAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setNewErr('');
    try {
      if (!hasWrite) {
        if (handle) await authService.requestWriteForCollections(handle);
        return; // user will return post-auth
      }
      setCreating(true);
      const col = await createCollection(newName.trim(), newColor);
      setCollections(prev => [col, ...prev]);
      // auto-add current post to the new collection
      await addPostToCollection(col.uri, post.uri);
      setNewName('');
      setNewColor('#3b82f6');
      setChooserOpen(false);
    } catch (e: any) {
      setNewErr(e?.message || 'Failed to create');
    } finally {
      setCreating(false);
    }
  }
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getPostUrl = (post: BlueskyPost) => {
    const parts = post.uri.split('/');
    const rkey = parts[4];
    return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
  };

  const renderPostText = (text: string) => {
    // Linkify: URLs, hashtags
    const url = /(https?:\/\/[^\s]+)/g;
    const hashtag = /(^|\s)(#[\p{L}\p{N}_]+)\b/gu;
    // Split then process tokens; keep simple for now
    const parts = text.split(url);
    return parts.map((part, idx) => {
      if (url.test(part)) {
        return (
          <a key={`u-${idx}`} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
            {part}
          </a>
        );
      }
      // Convert hashtags
  const withTags = part.replace(hashtag, (_match, lead, tag) => `${lead}<a href="https://bsky.app/hashtag/${encodeURIComponent(tag.slice(1))}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">${tag}</a>`);
      return <span key={`t-${idx}`} dangerouslySetInnerHTML={{ __html: withTags }} />;
    });
  };

  const renderEmbed = () => {
    const e: any = post.embed;
    if (!e) return null;

    // app.bsky.embed.images
    if (e.$type === 'app.bsky.embed.images#view' && Array.isArray(e.images)) {
      return (
        <div className="grid grid-cols-2 gap-2">
          {e.images.map((img: any, i: number) => (
            <img key={i} src={img.thumb || img.fullsize} alt={img.alt || ''} className="rounded-lg object-cover w-full" />
          ))}
        </div>
      );
    }

    // app.bsky.embed.external
    if (e.$type === 'app.bsky.embed.external#view' && e.external) {
      const ext = e.external;
      return (
        <a href={ext.uri} target="_blank" rel="noopener noreferrer" className="block p-3 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700">
          {ext.thumb && <img src={ext.thumb} alt="" className="rounded mb-2 max-h-48 object-cover w-full" />}
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{ext.title}</div>
          {ext.description && <div className="text-sm text-gray-600 dark:text-gray-300">{ext.description}</div>}
        </a>
      );
    }

    // app.bsky.embed.video (view) — render video player for inline playback
    if (e.$type?.startsWith('app.bsky.embed.video') && (e.playlist || e.video)) {
      const videoSrc = e.playlist || e.video;
      const poster = e.thumbnail || e.poster;
      const isHLS = videoSrc.includes('.m3u8') || videoSrc.includes('playlist');
      const [videoError, setVideoError] = useState(false);

      return (
        <div className="relative">
          {!videoError ? (
            <video
              src={videoSrc}
              poster={poster}
              controls
              playsInline
              preload="metadata"
              className="rounded-lg w-full max-h-96 object-contain"
              style={{ maxHeight: '24rem' }}
              {...(isHLS && { type: 'application/x-mpegURL' })}
              onError={() => setVideoError(true)}
            >
              Your browser does not support the video tag.
            </video>
          ) : (
            <div className="relative">
              <img src={poster} alt="video" className="rounded-lg object-cover w-full" />
              <div className="absolute inset-0 flex items-center justify-center">
                <a
                  href={getPostUrl(post)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-black/50 rounded-full p-3 hover:bg-black/70 transition-colors"
                  title="View video on Bluesky"
                >
                  <Play className="h-6 w-6 text-white" />
                </a>
              </div>
              <div className="absolute bottom-2 left-2 text-xs text-white bg-black/50 px-2 py-1 rounded">
                View on Bluesky
              </div>
            </div>
          )}
          {isHLS && !videoError && (
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              HLS video - may require browser support
            </div>
          )}
        </div>
      );
    }

    // Fallback: poster with play icon if no video src
    if (e.$type?.startsWith('app.bsky.embed.video') && (e.thumbnail || e.poster)) {
      const thumb = e.thumbnail || e.poster;
      return (
        <div className="relative">
          <img src={thumb} alt="video" className="rounded-lg object-cover w-full" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-black/50 rounded-full p-3">
              <Play className="h-6 w-6 text-white" />
            </div>
          </div>
        </div>
      );
    }

    // app.bsky.embed.record, recordWithMedia: show a compact quoted post preview if available
  if (e.$type === 'app.bsky.embed.record#view' && e.record && e.record.value) {
      const r = e.record;
      const author = r.author;
      const text = r.value?.text || '';
      return (
    <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-start space-x-2">
            {author?.avatar && <img src={author.avatar} alt={author?.handle} className="w-8 h-8 rounded-full" />}
            <div className="min-w-0">
        <div className="text-gray-900 dark:text-gray-100 font-medium truncate">{author?.displayName || author?.handle}</div>
        <div className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
                {renderPostText(text)}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (e.$type === 'app.bsky.embed.recordWithMedia#view') {
      // render record then media
      const rec = { $type: 'app.bsky.embed.record#view', record: e.record } as any;
      return (
        <div className="space-y-3">
          {(() => {
            const saved = (post as any).embed;
            (post as any).embed = rec; // temporarily render record
            const view = renderEmbed();
            (post as any).embed = saved; // restore
            return view;
          })()}
          {(() => {
            const saved = (post as any).embed;
            (post as any).embed = e.media; // then media
            const view = renderEmbed();
            (post as any).embed = saved;
            return view;
          })()}
        </div>
      );
    }

    return (
      <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <p className="text-sm text-gray-600 dark:text-gray-300">📎 Embedded content</p>
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow border border-gray-200 dark:border-gray-800">
      <div className="flex items-start space-x-3">
        {post.author.avatar && (
          <img
            src={post.author.avatar}
            alt={post.author.displayName || post.author.handle}
            className="w-12 h-12 rounded-full object-cover"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
              {post.author.displayName || post.author.handle}
            </h3>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              @{post.author.handle}
            </span>
            <span className="text-sm text-gray-400 dark:text-gray-600">·</span>
            <time className="text-sm text-gray-500 dark:text-gray-400">
              {formatDate(post.record.createdAt)}
            </time>
          </div>
          
          <div className="text-gray-800 dark:text-gray-100 mb-4 whitespace-pre-wrap">
            {renderPostText(post.record.text)}
          </div>

          {post.embed && <div className="mb-4">{renderEmbed()}</div>}

          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-6 text-gray-500 dark:text-gray-400">
              {post.replyCount !== undefined && (
                <div className="flex items-center space-x-1">
                  <MessageCircle className="h-4 w-4" />
                  <span className="text-sm">{post.replyCount}</span>
                </div>
              )}
              {post.repostCount !== undefined && (
                <div className="flex items-center space-x-1">
                  <Repeat2 className="h-4 w-4" />
                  <span className="text-sm">{post.repostCount}</span>
                </div>
              )}
              {post.likeCount !== undefined && (
                <div className="flex items-center space-x-1">
                  <Heart className="h-4 w-4" />
                  <span className="text-sm">{post.likeCount}</span>
                </div>
              )}
            </div>
            
            <a
              href={getPostUrl(post)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center space-x-1 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 text-sm"
            >
              <span>View on Bluesky</span>
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={()=>setChooserOpen(v=>!v)} className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center space-x-1">
              <Plus className="h-4 w-4" />
              <span>Add to collection</span>
            </button>
          </div>
          {chooserOpen && (
            <div className="mt-2 p-2 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-gray-600 dark:text-gray-300">Choose a collection</div>
                <button
                  title="Create new collection"
                  onClick={() => { /* toggle create inline row */ setNewErr(''); setNewName(n => n); }}
                  className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                >+ New</button>
              </div>
              {collections.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">No collections yet.</div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2 mb-2">
                  {collections.map(c => (
                    <button key={c.uri} onClick={()=>onAddTo(c.uri)} className="text-left px-3 py-2 rounded border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800">
                      <div className="flex items-center space-x-2">
                        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.value.color }} />
                        <span className="text-sm text-gray-900 dark:text-gray-100">{c.value.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={onCreateAndAdd} className="flex items-center gap-2 border-t border-gray-200 dark:border-gray-800 pt-2">
                <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New collection name" className="flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs" />
                <input type="color" value={newColor} onChange={e=>setNewColor(e.target.value)} title="Color" className="w-6 h-6 p-0 border-0 bg-transparent" />
                <button type="submit" disabled={creating} className="px-2 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-50">{creating ? 'Creating…' : 'Create & add'}</button>
                {!hasWrite && (
                  <button type="button" onClick={async ()=>{ if (handle) await authService.requestWriteForCollections(handle); }} className="px-2 py-1 rounded bg-indigo-600 text-white text-xs">Enable writing</button>
                )}
              </form>
              {newErr && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{newErr}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
