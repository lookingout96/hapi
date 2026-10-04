import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('HTTP 404') || error.message.includes('Session not found'))
}

// Session detail freshness is driven by SSE events (`useSSE` patches the cache
// directly on `session-updated`).  The REST endpoint is only a cold-start /
// reconnect-recovery path, so a long per-query staleTime extends the global
// default (5s, see `web/src/lib/query-client.ts`) for `useSession` only — this
// suppresses remount-refetch when the user navigates back to a recently-viewed
// session within the window, without making the UI stale.  Explicit
// `invalidateQueries` calls (SSE fallback path, reconnect-recovery in
// `App.tsx`) still refetch active observers regardless of staleTime, so live
// updates and recovery flows continue to work.  See tiann/hapi#884.
export const SESSION_DETAIL_STALE_TIME_MS = 30_000
const SESSION_SNAPSHOT_PREFIX = 'hapi.session-snapshot.v1::'

type SessionSnapshot = {
    savedAt: number
    data: SessionResponse
}

function readSessionSnapshot(sessionId: string): SessionSnapshot | null {
    try {
        const raw = sessionStorage.getItem(`${SESSION_SNAPSHOT_PREFIX}${sessionId}`)
        if (!raw) return null
        const snapshot = JSON.parse(raw) as Partial<SessionSnapshot>
        if (!snapshot.data?.session || snapshot.data.session.id !== sessionId || typeof snapshot.savedAt !== 'number') {
            return null
        }
        return snapshot as SessionSnapshot
    } catch {
        return null
    }
}

function writeSessionSnapshot(sessionId: string, data: SessionResponse): void {
    try {
        sessionStorage.setItem(`${SESSION_SNAPSHOT_PREFIX}${sessionId}`, JSON.stringify({
            savedAt: Date.now(),
            data,
        } satisfies SessionSnapshot))
    } catch {
        // A live request remains the fallback when storage is unavailable/full.
    }
}

export function useSession(api: ApiClient | null, sessionId: string | null): {
    session: Session | null
    isLoading: boolean
    error: string | null
    notFound: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const snapshot = useMemo(() => sessionId ? readSessionSnapshot(sessionId) : null, [sessionId])
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const data = await api.getSession(sessionId)
            writeSessionSnapshot(sessionId, data)
            return data
        },
        enabled: Boolean(api && sessionId),
        initialData: snapshot?.data,
        initialDataUpdatedAt: snapshot?.savedAt,
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    return {
        session: query.data?.session ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound: isSessionNotFoundError(query.error) && !query.isFetching,
        refetch: query.refetch,
    }
}
