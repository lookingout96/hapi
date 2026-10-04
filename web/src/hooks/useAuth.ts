import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const payload = JSON.parse(decoded) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: AuthSource): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    return { accessToken: source.token }
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'
const AUTH_SESSION_PREFIX = 'hapi_auth_session::'

type CachedAuth = {
    token: string
    user: AuthResponse['user']
}

function authSourceFingerprint(source: AuthSource): string {
    const value = source.type === 'telegram' ? source.initData : source.token
    let hash = 2166136261
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `${source.type}:${(hash >>> 0).toString(36)}`
}

function authSessionKey(baseUrl: string, source: AuthSource): string {
    return `${AUTH_SESSION_PREFIX}${baseUrl}::${authSourceFingerprint(source)}`
}

function readCachedAuth(baseUrl: string, source: AuthSource): CachedAuth | null {
    try {
        const raw = sessionStorage.getItem(authSessionKey(baseUrl, source))
        if (!raw) return null
        const cached = JSON.parse(raw) as Partial<CachedAuth>
        if (typeof cached.token !== 'string' || !cached.user) return null
        const expMs = decodeJwtExpMs(cached.token)
        if (!expMs || expMs <= Date.now()) {
            sessionStorage.removeItem(authSessionKey(baseUrl, source))
            return null
        }
        return cached as CachedAuth
    } catch {
        return null
    }
}

function writeCachedAuth(baseUrl: string, source: AuthSource, auth: CachedAuth): void {
    if (!decodeJwtExpMs(auth.token)) return
    try {
        sessionStorage.setItem(authSessionKey(baseUrl, source), JSON.stringify(auth))
    } catch {
        // Ignore unavailable/full storage; network authentication remains the fallback.
    }
}

function clearCachedAuth(baseUrl: string, source: AuthSource): void {
    try {
        sessionStorage.removeItem(authSessionKey(baseUrl, source))
    } catch {
        // Ignore storage errors.
    }
}

function rememberAccessToken(baseUrl: string, accessToken: string): void {
    try {
        localStorage.setItem(`${ACCESS_TOKEN_PREFIX}${baseUrl}`, accessToken)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
} {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthResponse['user'] | null>(null)
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [needsBinding, setNeedsBinding] = useState<boolean>(false)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)
    const previousBaseUrlRef = useRef(baseUrl)

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        const currentSource = authSourceRef.current
        const currentToken = tokenRef.current
        if (!currentSource) {
            return null
        }

        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        if (!options?.force && ttlMs !== null && ttlMs > minTtlMs) {
            return currentToken
        }
        if (!options?.force && !needsRefreshForTtl && now - lastRefreshAttemptRef.current < 15_000) {
            return currentToken
        }
        if (refreshPromiseRef.current) {
            return await refreshPromiseRef.current
        }

        const run = async () => {
            lastRefreshAttemptRef.current = now

            try {
                const client = new ApiClient('', { baseUrl })
                const auth = await client.authenticate(getAuthPayload(currentSource))
                tokenRef.current = auth.token
                setToken(auth.token)
                setUser(auth.user)
                writeCachedAuth(baseUrl, currentSource, auth)
                setError(null)
                setNeedsBinding(false)
                return auth.token
            } catch (error) {
                if (currentSource.type === 'telegram' && isNotBoundError(error)) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return null
                }
                const isExpired = expMs ? Date.now() >= expMs : false
                if (options?.hardFail || isExpired) {
                    clearCachedAuth(baseUrl, currentSource)
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    const msg = currentSource.type === 'telegram'
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : 'Session expired. Please login again.'
                    setError(msg)
                }
                return null
            }
        }

        const refreshPromise = run()
        refreshPromiseRef.current = refreshPromise

        try {
            return await refreshPromise
        } finally {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null
            }
        }
    }, [baseUrl])

    const bind = useCallback(async (accessToken: string) => {
        const currentSource = authSourceRef.current
        if (!currentSource || currentSource.type !== 'telegram') {
            setError('Binding is only supported in Telegram.')
            return
        }

        setIsLoading(true)
        setError(null)
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: currentSource.initData, accessToken })
            tokenRef.current = auth.token
            setToken(auth.token)
            setUser(auth.user)
            writeCachedAuth(baseUrl, currentSource, auth)
            setNeedsBinding(false)
            // Persist the CLI access token so Settings → Companion pairing QR
            // can encode the same long-lived token in the deeplink. The PWA
            // already does this for browser/CLI logins via useAuthSource.
            rememberAccessToken(baseUrl, accessToken)
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Binding failed')
            throw error
        } finally {
            setIsLoading(false)
        }
    }, [baseUrl])

    // Keep the ApiClient referentially stable across token *refreshes*: the client always reads
    // the live token via getToken (tokenRef), so it never needs rebuilding when the token value
    // changes — only when auth presence toggles (login/logout). Rebuilding on every refresh churns
    // `api`'s identity, which remounts everything keyed on it (VoiceBackendSession `[props.api]`,
    // GeneratedImageCard `[ctx.api, ...]`) and drives the remount/refetch storm. Issue #927.
    const hasToken = token !== null
    const api = useMemo(() => (
        hasToken
            ? new ApiClient(tokenRef.current ?? '', {
                baseUrl,
                getToken: () => tokenRef.current,
                onUnauthorized: () => refreshAuth({ force: true })
            })
            : null
    ), [baseUrl, refreshAuth, hasToken])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!authSource) {
                // No auth source - waiting for login
                setNeedsBinding(false)
                return
            }

            const cached = readCachedAuth(baseUrl, authSource)
            if (cached) {
                tokenRef.current = cached.token
                setToken(cached.token)
                setUser(cached.user)
            }
            setIsLoading(!cached)
            setError(null)
            setNeedsBinding(false)
            try {
                const client = new ApiClient('', { baseUrl }) // temporary for auth call
                const auth = await client.authenticate(getAuthPayload(authSource))
                if (isCancelled) return
                setToken(auth.token)
                setUser(auth.user)
                tokenRef.current = auth.token
                writeCachedAuth(baseUrl, authSource, auth)
                setNeedsBinding(false)
            } catch (e) {
                if (isCancelled) return
                if (authSource.type === 'telegram' && isNotBoundError(e)) {
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return
                }
                if (!cached) {
                    setNeedsBinding(false)
                    setError(e instanceof Error ? e.message : 'Auth failed')
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false)
                }
            }
        }

        run()

        return () => {
            isCancelled = true
        }
    }, [authSource, baseUrl])

    useEffect(() => {
        if (previousBaseUrlRef.current === baseUrl) return
        previousBaseUrlRef.current = baseUrl
        tokenRef.current = null
        refreshPromiseRef.current = null
        lastRefreshAttemptRef.current = 0
        setToken(null)
        setUser(null)
        setError(null)
        setNeedsBinding(false)
    }, [baseUrl])

    useEffect(() => {
        if (!token || !authSource) {
            return
        }

        const expMs = decodeJwtExpMs(token)
        if (!expMs) {
            return
        }

        let isCancelled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const schedule = (delayMs: number) => {
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed && Date.now() < expMs) {
                schedule(15_000)
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [authSource, refreshAuth, token])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token, user, api, isLoading, error, needsBinding, bind }
}
