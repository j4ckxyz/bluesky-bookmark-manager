import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Loader2,
  Server,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ApiError, api } from "../lib/api.ts";
import { useDebounced } from "../lib/hooks.ts";
import type { InstanceInfo } from "../lib/types.ts";
import { HandleTypeahead } from "./HandleTypeahead.tsx";

type Props = {
  instance: InstanceInfo | null;
  onSignedIn: () => void;
};

export function SignIn({ instance, onSignedIn }: Props) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [service, setService] = useState("");
  const [authFactorToken, setAuthFactorToken] = useState("");
  const [needsAuthFactor, setNeedsAuthFactor] = useState(false);
  const [showProvider, setShowProvider] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detectedProvider, setDetectedProvider] = useState<string | null>(null);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const handleId = useId();
  const passwordId = useId();
  const serviceId = useId();
  const codeId = useId();

  const debouncedHandle = useDebounced(handle.trim().replace(/^@/, ""), 450);

  // Resolve the hosting provider as they type, so it is already filled in and
  // correctable before they ever press the button.
  useEffect(() => {
    if (debouncedHandle.length < 4 || !debouncedHandle.includes(".")) {
      setDetectedProvider(null);
      setDetectedUrl(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setResolving(true);

    api
      .resolveIdentity(debouncedHandle, controller.signal)
      .then((identity) => {
        if (cancelled) return;
        setDetectedProvider(identity.providerLabel);
        setDetectedUrl(identity.pdsUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setDetectedProvider(null);
        setDetectedUrl(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedHandle]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.login({
        identifier: handle.trim(),
        password: password.trim(),
        ...(service.trim() ? { service: service.trim() } : {}),
        ...(authFactorToken.trim()
          ? { authFactorToken: authFactorToken.trim() }
          : {}),
      });
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "auth_factor_required") {
        setNeedsAuthFactor(true);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
      }
      setSubmitting(false);
    }
  };

  /*
   * A claimed single-user instance is closed to *new* accounts, but the
   * account that claimed it must still be able to sign in again — that is how
   * a second device (or a fresh browser) gets in. So the form always renders;
   * the server rejects a different account with its own message.
   */
  const singleAccount =
    instance !== null && instance.claimed && !instance.multiUser;

  return (
    <div className="signin">
      <div className="signin__card">
        <header className="signin__header">
          <span className="signin__mark" aria-hidden="true">
            <Bookmark size={22} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="signin__title">Your Bluesky bookmarks</h1>
            <p className="hint" style={{ marginTop: 4 }}>
              Signed in once, then kept in step automatically.
            </p>
          </div>
        </header>

        {singleAccount && (
          <p className="hint" style={{ marginBottom: "var(--space-4)" }}>
            This instance is set up for one account. Sign in with it to add
            another device.
          </p>
        )}

        <form onSubmit={submit} noValidate>
          <div className="signin__field">
            <label className="label" htmlFor={handleId}>
              Handle
            </label>
            <HandleTypeahead
              id={handleId}
              value={handle}
              onChange={setHandle}
              onPick={(actor) => setHandle(actor.handle)}
              disabled={submitting}
            />
          </div>

          <div className="signin__field">
            <label className="label" htmlFor={passwordId}>
              App password
            </label>
            <input
              id={passwordId}
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autoComplete="current-password"
              disabled={submitting}
              required
            />
            <p className="hint" style={{ marginTop: 6 }}>
              Create one under Settings → Privacy and security → App passwords.
              Your main password is never needed.
            </p>
          </div>

          {needsAuthFactor && (
            <div className="signin__field">
              <label className="label" htmlFor={codeId}>
                Confirmation code
              </label>
              <input
                id={codeId}
                className="input"
                type="text"
                value={authFactorToken}
                onChange={(event) => setAuthFactorToken(event.target.value)}
                placeholder="XXXXX-XXXXX"
                autoComplete="one-time-code"
                disabled={submitting}
              />
            </div>
          )}

          <div className="signin__field">
            <button
              type="button"
              className="disclosure"
              onClick={() => setShowProvider((open) => !open)}
              aria-expanded={showProvider}
            >
              {showProvider ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              <Server size={13} />
              Hosting provider
              {!showProvider && (
                <span style={{ color: "var(--text-faint)" }}>
                  {resolving
                    ? "· checking…"
                    : detectedProvider
                      ? `· ${detectedProvider}`
                      : "· detected automatically"}
                </span>
              )}
            </button>

            {showProvider && (
              <div style={{ marginTop: 10 }}>
                <input
                  id={serviceId}
                  className="input"
                  type="text"
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                  placeholder={detectedUrl ?? "https://bsky.social"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                />
                <p className="hint" style={{ marginTop: 6 }}>
                  {detectedUrl ? (
                    <>
                      We found <span className="code">{detectedUrl}</span>.
                      Leave this blank unless that is wrong.
                    </>
                  ) : (
                    "Leave blank to detect it from your handle. Set it if detection fails or you self-host."
                  )}
                </p>
              </div>
            )}
          </div>

          {error && (
            <div
              className="error-box"
              style={{ marginBottom: 16 }}
              role="alert"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className="button button--primary"
            style={{ width: "100%", padding: "9px 13px" }}
            disabled={
              submitting ||
              handle.trim().length === 0 ||
              password.trim().length === 0
            }
          >
            {submitting ? (
              <>
                <Loader2 size={15} className="spin" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="signin__footer">
          Everything stays on this server. Your app password is exchanged for a
          session token, encrypted at rest, and used only to read your
          bookmarks.
        </p>
      </div>
    </div>
  );
}
