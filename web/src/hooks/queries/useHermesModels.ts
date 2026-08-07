import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HermesModelSummary, HermesModelsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { getOpencodeModelsRefetchInterval, shouldRetryOpencodeModelsQuery } from './useOpencodeModels'

export function useHermesModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: HermesModelSummary[]
    currentModelId: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)
    const query = useQuery({
        queryKey: sessionId ? queryKeys.sessionHermesModels(sessionId) : ['session-hermes-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !sessionId) throw new Error('Hermes models target unavailable')
            return await api.getSessionHermesModels(sessionId)
        },
        enabled,
        retry: (failureCount) => shouldRetryOpencodeModelsQuery(failureCount),
        refetchInterval: (result) => getOpencodeModelsRefetchInterval(
            enabled,
            result.state.data as HermesModelsResponse | undefined,
            result.state.fetchFailureCount
        ),
    })
    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
    }
}
