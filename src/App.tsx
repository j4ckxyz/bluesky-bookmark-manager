import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './components/Login';
import { Bookmarks } from './components/Bookmarks';
import { Collections, CollectionDetail } from './components/Collections';
import { AuthCallback } from './components/AuthCallback';
import { authService } from './services/auth';
import type { UserSession } from './types';

function App() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [theme, setTheme] = useState<'light'|'dark'|'system'>(() => (localStorage.getItem('theme') as any) || 'system');

  // Apply theme based on system preference or explicit choice
  useEffect(() => {
    const root = document.documentElement;
    const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme;
    root.classList.toggle('dark', effective === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  // React to live system changes when on system mode
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (localStorage.getItem('theme') === 'system') {
        document.documentElement.classList.toggle('dark', mql.matches);
      }
    };
    mql.addEventListener?.('change', handler);
    return () => mql.removeEventListener?.('change', handler);
  }, []);

  useEffect(() => {
    // Check for existing session on app load
    const existingSession = authService.getStoredSession();
    setSession(existingSession);
    setIsLoading(false);
  }, []);

  const handleLogin = () => {
    // This will be called after successful OAuth redirect
    const session = authService.getStoredSession();
    setSession(session);
  };

  const handleLogout = () => {
    setSession(null);
  };

  const handleAuthSuccess = (newSession: UserSession) => {
    setSession(newSession);
  };

  const handleAuthError = () => {
    setSession(null);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <Router>
      <Routes>
        <Route 
          path="/auth/callback" 
          element={
            <AuthCallback 
              onAuthSuccess={handleAuthSuccess}
              onAuthError={handleAuthError}
            />
          } 
        />
        <Route 
          path="/" 
          element={
            session ? (
              <Bookmarks session={session} onLogout={handleLogout} />
            ) : (
              <Login onLogin={handleLogin} />
            )
          } 
        />
        <Route 
          path="/collections" 
          element={
            session ? (
              <Collections onOpenCollection={(c)=>window.location.assign(`/collections/${encodeURIComponent(c.rkey)}`)} />
            ) : (
              <Navigate to="/" replace />
            )
          } 
        />
        <Route 
          path="/collections/:rkey" 
          element={
            session ? (
              <CollectionsWrapper />
            ) : (
              <Navigate to="/" replace />
            )
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Theme picker: compact dropdown, tucked in the top-right */}
      <div className="fixed top-2 right-2 z-50">
        <label htmlFor="theme-picker" className="sr-only">Theme</label>
        <select
          id="theme-picker"
          value={theme}
          onChange={(e) => setTheme(e.target.value as 'light'|'dark'|'system')}
          className="text-xs px-2 py-1 rounded-md bg-white/80 dark:bg-gray-800/80 backdrop-blur border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 shadow-sm hover:bg-white dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          title="Theme"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </Router>
  );
}

function CollectionsWrapper() {
  // lightweight wrapper to adapt URL :rkey to a collection URI for the current user
  const rkey = window.location.pathname.split('/').pop()!;
  const stored = sessionStorage.getItem('user_session');
  if (!stored) return <Navigate to="/" replace />;
  const session = JSON.parse(stored) as { did: string };
  const uri = `at://${session.did}/uk.atproto.bookmark.list/${rkey}`;
  return <CollectionDetail collectionUri={uri} onBack={()=>window.history.back()} />;
}

export default App;
