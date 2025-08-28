import { useEffect, useState } from 'react';
import { Plus, AlertTriangle, Link as LinkIcon } from 'lucide-react';
import { listCollections, createCollection, addPostToCollection, getCollection, parsePostInputToAtUri, type PostCollection } from '../services/collections';
import { PostCard } from './PostCard';
import { blueskyService } from '../services/bluesky';

interface CollectionsProps {
  onOpenCollection: (collection: PostCollection) => void;
}

export function Collections({ onOpenCollection }: CollectionsProps) {
  const [collections, setCollections] = useState<PostCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const cols = await listCollections();
      setCollections(cols);
    } catch (e: any) {
      setError(e?.message || 'Failed to load collections');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const col = await createCollection(name.trim(), color);
      setCollections([col, ...collections]);
      setName('');
    } catch (e: any) {
      setError(e?.message || 'Failed to create collection');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="bg-white dark:bg-gray-900 shadow-sm border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Post Collections</h1>
          <a href="/" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">Back to Bookmarks</a>
        </div>
      </header>
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="mb-4 p-3 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 flex items-start space-x-2">
          <AlertTriangle className="h-5 w-5 mt-0.5" />
          <div className="text-sm">Post collections are public. Anyone can view them with third-party tools.</div>
        </div>

        <form onSubmit={onCreate} className="mb-6 flex items-center space-x-2">
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="New collection name" className="flex-1 px-3 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <div className="flex items-center space-x-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-2">
            <input type="color" value={color} onChange={e=>setColor(e.target.value)} title="Color" className="w-6 h-6 p-0 border-0 bg-transparent" />
            <span className="text-xs text-gray-600 dark:text-gray-300">Color</span>
          </div>
          <button type="submit" className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center space-x-1"><Plus className="h-4 w-4"/><span>Create</span></button>
        </form>

        {loading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading…</div>
        ) : error ? (
          <div className="text-center py-8">
            <div className="max-w-md mx-auto p-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300">{error}</div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {collections.map(col => (
              <button key={col.uri} onClick={()=>onOpenCollection(col)} className="text-left p-4 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <div className="flex items-center space-x-2">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: col.value.color }} />
                  <div className="font-medium text-gray-900 dark:text-gray-100">{col.value.name}</div>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mt-1">{col.value.items.length} posts</div>
              </button>
            ))}
            {collections.length === 0 && (
              <div className="text-gray-600 dark:text-gray-300">No collections yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface CollectionDetailProps {
  collectionUri: string;
  onBack: () => void;
}

export function CollectionDetail({ collectionUri, onBack }: CollectionDetailProps) {
  const [collection, setCollection] = useState<PostCollection | null>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const col = await getCollection(collectionUri);
      setCollection(col);
      if (col.value.items.length) {
        const fetched = await blueskyService.getPosts(col.value.items);
        setPosts(fetched);
      } else {
        setPosts([]);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load collection');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [collectionUri]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !collection) return;
    try {
      const atUri = await parsePostInputToAtUri(input);
      const updated = await addPostToCollection(collection.uri, atUri);
      setCollection(updated);
      const fetched = await blueskyService.getPosts([atUri]);
      setPosts(prev => [...fetched.filter(p=>!prev.some(x=>x.uri===p.uri)), ...prev]);
      setInput('');
    } catch (e: any) {
      setError(e?.message || 'Failed to add post');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="bg-white dark:bg-gray-900 shadow-sm border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <button onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
          {collection && (
            <div className="flex items-center space-x-2">
              <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: collection.value.color }} />
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{collection.value.name}</h2>
            </div>
          )}
          <div />
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="mb-4 p-3 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 text-sm">
          Public: others can view this list via third-party tools.
        </div>

        <form onSubmit={onAdd} className="mb-6 flex items-center space-x-2">
          <div className="relative flex-1">
            <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input value={input} onChange={e=>setInput(e.target.value)} placeholder="Paste at:// URI or Bluesky post URL" className="w-full pl-9 pr-3 py-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button type="submit" className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">Add</button>
        </form>

        {loading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading…</div>
        ) : error ? (
          <div className="text-center py-8">
            <div className="max-w-md mx-auto p-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300">{error}</div>
          </div>
        ) : posts.length === 0 ? (
          <div className="text-gray-600 dark:text-gray-300">No posts in this collection yet.</div>
        ) : (
          <div className="space-y-4">
            {posts.map(p => <PostCard key={p.uri} post={p} />)}
          </div>
        )}
      </div>
    </div>
  );
}
