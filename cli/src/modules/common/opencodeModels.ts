import { asString, isObject } from '@hapi/protocol';
import type { OpencodeModelsResponse, OpencodeModelSummary } from '@hapi/protocol/apiTypes';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import packageJson from '../../../package.json';
import { getErrorMessage } from './rpcResponses';

export interface ListOpencodeModelsForCwdRequest {
    cwd?: string;
}

export type ListOpencodeModelsForCwdResponse = OpencodeModelsResponse;
export type ListHermesModelsForCwdRequest = ListOpencodeModelsForCwdRequest;
export type ListHermesModelsForCwdResponse = OpencodeModelsResponse;

interface CacheEntry {
    expiresAt: number;
    response: ListOpencodeModelsForCwdResponse;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListOpencodeModelsForCwdResponse>>();

function normalizeAvailableModels(rawModels: unknown): OpencodeModelSummary[] {
    if (!Array.isArray(rawModels)) return [];
    const out: OpencodeModelSummary[] = [];
    for (const entry of rawModels) {
        if (!isObject(entry)) continue;
        const modelId = asString(entry.modelId) ?? asString(entry.value);
        if (!modelId) continue;
        const name = asString(entry.name) ?? undefined;
        out.push(name ? { modelId, name } : { modelId });
    }
    return out;
}

function extractModelConfigOption(response: Record<string, unknown>): {
    currentValue: string | null;
    options: unknown[];
} | null {
    if (!Array.isArray(response.configOptions)) return null;

    for (const entry of response.configOptions) {
        if (!isObject(entry)) continue;
        if (asString(entry.category) !== 'model') continue;
        return {
            currentValue: asString(entry.currentValue),
            options: Array.isArray(entry.options) ? entry.options : []
        };
    }

    return null;
}

function extractModelsFromResponse(response: unknown): {
    availableModels: OpencodeModelSummary[];
    currentModelId: string | null;
} {
    if (!isObject(response)) {
        return { availableModels: [], currentModelId: null };
    }

    const directList = response.availableModels;
    const directCurrent = response.currentModelId;
    const nested = isObject(response.models) ? response.models : null;
    const nestedList = nested?.availableModels;
    const nestedCurrent = nested?.currentModelId;

    const configModelOption = extractModelConfigOption(response);
    const rawModels = Array.isArray(directList)
        ? directList
        : Array.isArray(nestedList)
            ? nestedList
            : configModelOption?.options ?? null;
    const rawCurrent = typeof directCurrent === 'string'
        ? directCurrent
        : typeof nestedCurrent === 'string'
            ? nestedCurrent
            : configModelOption?.currentValue ?? null;

    return {
        availableModels: normalizeAvailableModels(rawModels),
        currentModelId: rawCurrent
    };
}

async function runAcpModelProbe(cwd: string, flavor: 'opencode' | 'hermes'): Promise<ListOpencodeModelsForCwdResponse> {
    const transport = new AcpStdioTransport({
        command: flavor,
        args: ['acp']
    });

    try {
        const initResponse = await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            },
            clientInfo: {
                name: `hapi-${flavor}-models`,
                version: packageJson.version
            }
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        if (!isObject(initResponse) || typeof initResponse.protocolVersion !== 'number') {
            return { success: false, error: `Invalid initialize response from ${flavor} acp` };
        }

        const newResponse = await transport.sendRequest('session/new', {
            cwd,
            mcpServers: []
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        const { availableModels, currentModelId } = extractModelsFromResponse(newResponse);

        return {
            success: true,
            availableModels,
            currentModelId
        };
    } finally {
        await transport.close().catch(() => undefined);
    }
}

/**
 * Discover available OpenCode models for a given working directory by spawning
 * a short-lived `opencode acp` subprocess, sending `initialize` + `session/new`,
 * and capturing the `availableModels` / `currentModelId` snapshot from the
 * response. The subprocess is torn down immediately afterwards.
 *
 * Results are cached per cwd for 60 seconds; concurrent requests for the same
 * cwd are coalesced via a single-flight promise so we never spawn more than
 * one probe at a time per cwd.
 */
async function listAcpModelsForCwd(
    cwd: string,
    flavor: 'opencode' | 'hermes'
): Promise<ListOpencodeModelsForCwdResponse> {
    const trimmed = cwd?.trim();
    if (!trimmed) {
        return { success: false, error: 'cwd is required' };
    }

    const cacheKey = `${flavor}:${trimmed}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
    }

    const existing = inflight.get(cacheKey);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        try {
            const response = await runAcpModelProbe(trimmed, flavor);
            if (response.success) {
                cache.set(cacheKey, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    response
                });
            }
            return response;
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, `Failed to discover ${flavor === 'opencode' ? 'OpenCode' : 'Hermes'} models`)
            } satisfies ListOpencodeModelsForCwdResponse;
        } finally {
            inflight.delete(cacheKey);
        }
    })();

    inflight.set(cacheKey, promise);
    return promise;
}

export async function listOpencodeModelsForCwd(cwd: string): Promise<ListOpencodeModelsForCwdResponse> {
    return await listAcpModelsForCwd(cwd, 'opencode');
}

export async function listHermesModelsForCwd(cwd: string): Promise<ListHermesModelsForCwdResponse> {
    return await listAcpModelsForCwd(cwd, 'hermes');
}

/**
 * Clear the in-process cache. Exposed for tests.
 */
export function _resetOpencodeModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
}
