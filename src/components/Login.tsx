import { useState } from 'react';
import { LogIn, Bookmark } from 'lucide-react';
import { authService } from '../services/auth';

interface LoginProps {
  onLogin: () => void;
}

export function Login({ onLogin: _onLogin }: LoginProps) {
  const [handle, setHandle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      // Normalize the handle
      let normalizedHandle = handle.trim().toLowerCase();
      
      // Remove @ if present
      if (normalizedHandle.startsWith('@')) {
        normalizedHandle = normalizedHandle.substring(1);
      }
      
      // Add .bsky.social if no domain is present
      if (!normalizedHandle.includes('.')) {
        normalizedHandle += '.bsky.social';
      }

      console.log(`Attempting to authenticate with handle: ${normalizedHandle}`);
      await authService.initiateAuth(normalizedHandle);
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-900 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl p-8 w-full max-w-md border border-transparent dark:border-gray-800">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-blue-100 rounded-full">
              <Bookmark className="h-8 w-8 text-blue-600" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Bluesky Bookmarks
          </h1>
          <p className="text-gray-600 dark:text-gray-300">
            View your bookmarked posts by signing in with your Bluesky handle
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="handle" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Bluesky Handle
            </label>
            <input
              id="handle"
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="your-handle.bsky.social"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md">
              <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !handle.trim()}
            className="w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            ) : (
              <>
                <LogIn className="h-4 w-4 mr-2" />
                Sign in with Bluesky
              </>
            )}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <div className="text-xs text-gray-500 dark:text-gray-400 space-y-2">
            <p>
              This app searches for posts you've replied to with 📌 emoji to simulate bookmarks.
            </p>
            <p>Built with ❤️ and written with Claude Sonnet 4.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
