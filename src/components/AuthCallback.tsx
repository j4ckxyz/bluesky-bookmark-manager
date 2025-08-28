import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authService } from '../services/auth';
import type { UserSession } from '../types';

interface AuthCallbackProps {
  onAuthSuccess: (session: UserSession) => void;
  onAuthError: () => void;
}

export function AuthCallback({ onAuthSuccess, onAuthError }: AuthCallbackProps) {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState('');
  const ranRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (ranRef.current) return; // guard against React Strict Mode double effect
    ranRef.current = true;
    const handleCallback = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setError(`Authentication failed: ${errorParam}`);
        setTimeout(onAuthError, 2000);
        return;
      }

      if (!code || !state) {
        setError('Invalid authentication response');
        setTimeout(onAuthError, 2000);
        return;
      }

      try {
        const session = await authService.handleAuthCallback(code, state);
        onAuthSuccess(session);
        // Navigate to home after successful authentication
        navigate('/', { replace: true });
      } catch (err) {
        console.error('Auth callback error:', err);
        setError(err instanceof Error ? err.message : 'Authentication failed');
        setTimeout(() => {
          onAuthError();
          navigate('/', { replace: true });
        }, 1500);
      }
    };

  handleCallback();
  }, [searchParams, onAuthSuccess, onAuthError]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md text-center">
        {error ? (
          <div>
            <div className="text-red-600 mb-4">
              <svg className="w-12 h-12 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Authentication Failed
            </h2>
            <p className="text-gray-600 mb-4">{error}</p>
            <p className="text-sm text-gray-500">Redirecting back to login...</p>
          </div>
        ) : (
          <div>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Completing Authentication
            </h2>
            <p className="text-gray-600">Please wait while we finish signing you in...</p>
          </div>
        )}
      </div>
    </div>
  );
}
