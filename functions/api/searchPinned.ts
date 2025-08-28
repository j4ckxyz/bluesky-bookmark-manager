export async function onRequest(context: any): Promise<Response> {
  try {
    // Handle CORS preflight
    if (context.request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders('text/plain') });
    }
    const url = new URL(context.request.url);
    const handle = (url.searchParams.get('handle') || '').replace(/^@/, '');
    const limit = url.searchParams.get('limit') || '50';
    const cursor = url.searchParams.get('cursor') || '';
    if (!handle) {
      return new Response(JSON.stringify({ error: 'missing handle' }), {
        status: 400,
        headers: corsHeaders('application/json'),
      });
    }
    // Enforce pinned-only search
    const q = `from:${handle} 📌`;
    const target = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
    target.searchParams.set('q', q);
    target.searchParams.set('limit', String(Math.min(Math.max(Number(limit) || 50, 1), 100)));
    if (cursor) target.searchParams.set('cursor', cursor);

    // Some edge deployments require a UA; also forward Accept only
    const upstreamHeaders: HeadersInit = {
      'Accept': 'application/json',
      'User-Agent': 'bluesky-bookmarks-pages-fn/1.0 (+https://bookmarks.atproto.uk)'
    };
    const resp = await fetch(target.toString(), { method: 'GET', headers: upstreamHeaders });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: corsHeaders(resp.headers.get('content-type') || 'application/json'),
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'proxy failed' }), {
      status: 502,
      headers: corsHeaders('application/json'),
    });
  }
}

function corsHeaders(contentType: string): HeadersInit {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'max-age=30, s-maxage=30',
  };
}
