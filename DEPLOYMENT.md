# Deployment

This app runs locally for development and on Cloudflare Pages at https://bookmarks.atproto.uk.

## URLs and OAuth
- Production domain: https://bookmarks.atproto.uk
- OAuth client metadata: https://bookmarks.atproto.uk/oauth/client-metadata.json
- Redirect URI: https://bookmarks.atproto.uk/auth/callback
- Local redirect URI: http://127.0.0.1:5173/auth/callback

The app auto-selects the OAuth client:
- On the production domain it uses the hosted client_id above.
- Locally it uses the special localhost client_id format supported by AT Protocol issuers.

## Cloudflare Pages
1) Build command
```
npm run build
```

2) Build output directory
```
dist
```

3) Framework preset
- None (Vite)

4) Routing
- A `_redirects` file is included to enable SPA fallback to `/index.html`.

5) Environment
- No server-side secrets are required. All OAuth happens in the browser.

## Local development
```
npm install
npm run dev
```

Then open http://127.0.0.1:5173. The app will request OAuth using the special localhost client_id and redirect back to `/auth/callback`.

## Notes
- When deploying to previews under a different hostname, the client_id is still the production one; most issuers accept it as long as redirect_uri matches one of the allowed URIs in `public/oauth/client-metadata.json`. If preview host differs, consider editing the metadata or using the localhost client in previews.
- If you change the domain, update `public/oauth/client-metadata.json` and the production client_id string in `src/services/auth.ts`.
