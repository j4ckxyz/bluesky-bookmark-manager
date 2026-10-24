import type {
  Account,
  ApiToken,
  InstanceInfo,
  ResolvedIdentity,
  SearchResponse,
  SessionResponse,
  SortOrder,
  Stats,
  StatusFilter,
  Suggestions,
  SyncProgress,
  TokenScope,
  TypeaheadActor,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let code = 'error'
    let message = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      code = body.error ?? code
      message = body.message ?? message
    } catch {
      // A non-JSON error body is not worth reporting verbatim.
    }
    throw new ApiError(response.status, code, message)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export type SearchParams = {
  q?: string
  limit?: number
  offset?: number
  sort?: SortOrder
  status?: StatusFilter
  facets?: boolean
  from?: string[]
  mentions?: string[]
  domain?: string[]
  tag?: string[]
  lang?: string[]
  has?: string[]
  is?: string[]
  before?: string
  after?: string
}

export function toQueryString(params: SearchParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','))
    } else if (typeof value === 'boolean') {
      if (value) search.set(key, '1')
    } else {
      search.set(key, String(value))
    }
  }
  return search.toString()
}

export const api = {
  instance: () => request<InstanceInfo>('/api/v1/instance'),

  session: () => request<SessionResponse>('/api/v1/auth/session'),

  login: (body: {
    identifier: string
    password: string
    service?: string
    authFactorToken?: string
  }) =>
    request<{ account: Account; providerLabel: string; sync: SyncProgress | null }>(
      '/api/v1/auth/login',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  logout: () => request<{ ok: true }>('/api/v1/auth/logout', { method: 'POST' }),

  disconnect: () => request<{ ok: true }>('/api/v1/auth/disconnect', { method: 'POST' }),

  typeahead: (q: string, signal?: AbortSignal) =>
    request<{ actors: TypeaheadActor[]; degraded?: boolean }>(
      `/api/v1/identity/typeahead?q=${encodeURIComponent(q)}`,
      signal ? { signal } : {},
    ),

  resolveIdentity: (handle: string, signal?: AbortSignal) =>
    request<ResolvedIdentity>(
      `/api/v1/identity/resolve?handle=${encodeURIComponent(handle)}`,
      signal ? { signal } : {},
    ),

  search: (params: SearchParams, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/v1/search?${toQueryString(params)}`, signal ? { signal } : {}),

  suggest: (q: string, signal?: AbortSignal) =>
    request<Suggestions>(`/api/v1/suggest?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),

  stats: (signal?: AbortSignal) => request<Stats>('/api/v1/stats', signal ? { signal } : {}),

  syncStatus: () =>
    request<{
      status: SyncProgress | null
      intervalMinutes: number
      nextMode: string
      totalStored: number
    }>('/api/v1/sync/status'),

  startSync: (mode?: 'backfill' | 'quick' | 'full') =>
    request<{ started: boolean; mode?: string; message?: string; status: SyncProgress | null }>(
      '/api/v1/sync',
      { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) },
    ),

  cancelSync: () =>
    request<{ cancelled: boolean; status: SyncProgress | null }>('/api/v1/sync/cancel', {
      method: 'POST',
    }),

  syncHistory: () => request<{ runs: SyncProgress[] }>('/api/v1/sync/history'),

  tokens: () => request<{ tokens: ApiToken[] }>('/api/v1/tokens'),

  createToken: (name: string, options: { scope?: TokenScope; expiresInDays?: number | null } = {}) =>
    request<ApiToken & { token: string }>('/api/v1/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, ...options }),
    }),

  revokeToken: (hint: string) =>
    request<{ revoked: boolean }>(`/api/v1/tokens/${encodeURIComponent(hint)}`, {
      method: 'DELETE',
    }),

  /** The agent SKILL.md, rendered for the address this page is served from. */
  agentSkill: async (baseUrl: string): Promise<string> => {
    const response = await fetch(`/api/agent/v1/skill?base_url=${encodeURIComponent(baseUrl)}`)
    if (!response.ok) throw new ApiError(response.status, 'error', 'Could not load the agent skill.')
    return response.text()
  },

  /** Exports are downloads, so they go through the browser, not fetch. */
  exportUrl: (format: string, params: SearchParams): string =>
    `/api/v1/export?${toQueryString({ ...params, limit: undefined, offset: undefined, facets: false })}&format=${format}`,
}
