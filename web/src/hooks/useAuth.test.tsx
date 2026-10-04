import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the network layer so we can drive token refreshes deterministically.
// The real ApiClient reads the live token via `getToken`, so the mock records the
// constructor options (including onUnauthorized) and hands out incrementing tokens.
const h = vi.hoisted(() => {
    let idSeq = 0
    let authCount = 0
    let authenticateImpl: (() => Promise<{ token: string; user: { id: string } }>) | null = null
    class MockApiClient {
        token: string
        options: { getToken?: () => string | null; onUnauthorized?: () => unknown; baseUrl?: string } | undefined
        readonly id: number
        constructor(token: string, options?: MockApiClient['options']) {
            this.token = token
            this.options = options
            this.id = ++idSeq
        }
        async authenticate(): Promise<{ token: string; user: { id: string } }> {
            if (authenticateImpl) return await authenticateImpl()
            authCount += 1
            return { token: `token-${authCount}`, user: { id: 'u1' } }
        }
    }
    class MockApiError extends Error {
        status: number
        code?: string
        constructor(message: string, status = 401, code?: string) {
            super(message)
            this.status = status
            this.code = code
        }
    }
    return {
        MockApiClient,
        MockApiError,
        setAuthenticateImpl(value: typeof authenticateImpl) { authenticateImpl = value },
        reset() { idSeq = 0; authCount = 0; authenticateImpl = null },
    }
})

vi.mock('@/api/client', () => ({ ApiClient: h.MockApiClient, ApiError: h.MockApiError }))

// Imported after the mock is registered (vi.mock is hoisted).
import { useAuth } from '@/hooks/useAuth'

type ApiWithOptions = {
    id: number
    options?: { getToken?: () => string | null; onUnauthorized?: () => unknown }
}

describe('useAuth — api identity stability across token refresh (issue #927)', () => {
    beforeEach(() => {
        h.reset()
        sessionStorage.clear()
    })

    it('keeps the same ApiClient instance when the token refreshes', async () => {
        // Stable authSource reference, exactly like the real caller (useAuthSource holds it in
        // useState). This isolates the bug under test: a *token* refresh, not a source change.
        const authSource = { type: 'accessToken' as const, token: 'seed' }
        const { result } = renderHook(() => useAuth(authSource, 'http://hub.test'))

        // Initial authenticate resolves and sets the first token.
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const api1 = result.current.api as unknown as ApiWithOptions
        const token1 = result.current.token
        expect(token1).toBe('token-1')

        // Drive the exact real-world trigger: a 401 invokes onUnauthorized,
        // which force-refreshes the token (this is what the flaky remote network does).
        await act(async () => {
            await api1.options?.onUnauthorized?.()
        })

        // The token did advance...
        expect(result.current.token).toBe('token-2')
        expect(result.current.token).not.toBe(token1)

        // ...but recreating the client was unnecessary: the OLD instance already serves
        // the fresh token via getToken, so nothing downstream needed a new `api` reference.
        expect(api1.options?.getToken?.()).toBe(result.current.token)

        // DESIRED: `api` stays referentially stable across a refresh, so effects keyed on
        // `api` (VoiceBackendSession `[props.api]`, GeneratedImageCard `[ctx.api, ...]`) do
        // NOT re-run / remount. On current code `api` is rebuilt because `token` is a useMemo
        // dep, which drives the Voice-remount spam + per-image refetch storm. This fails today.
        expect(result.current.api).toBe(api1 as unknown as typeof result.current.api)
    })

    it('restores a valid cached hub session before background authentication completes', async () => {
        const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
        const jwt = `header.${payload}.signature`
        const authSource = { type: 'accessToken' as const, token: 'seed' }
        h.setAuthenticateImpl(async () => ({ token: jwt, user: { id: 'u1' } }))

        const first = renderHook(() => useAuth(authSource, 'http://hub.test'))
        await waitFor(() => expect(first.result.current.token).toBe(jwt))
        first.unmount()

        h.setAuthenticateImpl(() => new Promise(() => {}))
        const restored = renderHook(() => useAuth(authSource, 'http://hub.test'))

        expect(restored.result.current.token).toBe(jwt)
        expect(restored.result.current.api).not.toBeNull()
        expect(restored.result.current.isLoading).toBe(false)
        restored.unmount()
    })
})
