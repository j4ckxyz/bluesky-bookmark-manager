/** Query parameters that only track where a click came from. */
const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|si)$/i

/**
 * A comparison key for a link, so the same page matches however it was
 * shared: scheme, `www.`, letter case in the host, a trailing slash, the
 * fragment and tracking parameters are all ignored.
 *
 *   https://www.Example.com/a/?utm_source=x#top  ->  example.com/a
 *   example.com/a                                 ->  example.com/a
 */
export function urlKey(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return trimmed.toLowerCase()
  }

  let host = url.hostname.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  const port = url.port ? `:${url.port}` : ''
  const path = url.pathname.replace(/\/+$/, '')
  const params = [...url.searchParams].filter(([key]) => !TRACKING_PARAM.test(key))
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
  return `${host}${port}${path}${query}`
}
