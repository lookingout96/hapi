/**
 * Locally declared Codex models that the Codex app-server catalog does not advertise.
 *
 * `model/list` is baked into the Codex binary, so a model the configured provider
 * serves but Codex has never heard of (e.g. `gpt-6-sol` on an OpenAI-compatible
 * relay) can never appear in the New Session picker — the web resets any selection
 * that is not in the catalog back to "auto". Codex itself accepts such a name at
 * runtime (`thread/start` with `model: "gpt-6-sol"` succeeds), so the catalog, not
 * the runtime, is the stale part.
 *
 * Sources, both optional and merged in order:
 *   1. `HAPI_CODEX_EXTRA_MODELS` — JSON array of ids or `{ id, displayName }`
 *   2. `<hapi home>/codex-models.json` — same shape, re-read on every request so
 *      adding a model needs no hub restart
 *
 * Codex's own entries always win on an id collision, so this can only add.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { CodexModelSummary } from '@hapi/protocol/apiTypes'

const EXTRA_MODELS_FILE_NAME = 'codex-models.json'

const extraModelSchema = z.object({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional()
})

const extraModelsSchema = z.array(z.union([z.string(), extraModelSchema]))

type ExtraModel = z.infer<typeof extraModelSchema>

/** File HAPI reads the extra-model list from: explicit override, else `<hapi home>/codex-models.json`. */
export function getExtraCodexModelsFile(): string {
    const explicit = process.env.HAPI_CODEX_MODELS_FILE?.trim()
    if (explicit) {
        return explicit
    }
    const hapiHome = process.env.HAPI_HOME?.trim()
    return join(hapiHome && hapiHome.length > 0 ? hapiHome : join(homedir(), '.hapi'), EXTRA_MODELS_FILE_NAME)
}

function normalizeEntries(raw: unknown, source: string): ExtraModel[] {
    const parsed = extraModelsSchema.safeParse(raw)
    if (!parsed.success) {
        console.warn(`[codex-extra-models] ignoring ${source}: expected an array of ids or { id, displayName }`)
        return []
    }

    const entries: ExtraModel[] = []
    for (const entry of parsed.data) {
        if (typeof entry === 'string') {
            const id = entry.trim()
            if (id) {
                entries.push({ id })
            }
            continue
        }
        entries.push(entry)
    }
    return entries
}

function readEntriesFromFile(source: string): ExtraModel[] {
    let content: string
    try {
        content = readFileSync(source, 'utf8')
    } catch {
        // Missing file is the normal case — the list is optional.
        return []
    }
    try {
        return normalizeEntries(JSON.parse(content), source)
    } catch (error) {
        console.warn(`[codex-extra-models] ignoring ${source}: ${error instanceof Error ? error.message : 'invalid JSON'}`)
        return []
    }
}

function readEntriesFromEnv(source: string): ExtraModel[] {
    const raw = process.env.HAPI_CODEX_EXTRA_MODELS?.trim()
    if (!raw) {
        return []
    }
    try {
        return normalizeEntries(JSON.parse(raw), source)
    } catch (error) {
        console.warn(`[codex-extra-models] ignoring ${source}: ${error instanceof Error ? error.message : 'invalid JSON'}`)
        return []
    }
}

/** Extra models declared locally, deduped by id. Never throws. */
export function readExtraCodexModels(): CodexModelSummary[] {
    const file = getExtraCodexModelsFile()
    const entries = [
        ...readEntriesFromFile(file),
        ...readEntriesFromEnv('HAPI_CODEX_EXTRA_MODELS')
    ]

    const seen = new Set<string>()
    const models: CodexModelSummary[] = []
    for (const entry of entries) {
        if (seen.has(entry.id)) {
            continue
        }
        seen.add(entry.id)
        models.push({
            id: entry.id,
            displayName: entry.displayName ?? entry.id,
            isDefault: false
        })
    }
    return models
}

/**
 * Append locally declared models to a catalog response, keeping catalog entries
 * (and their default/tier metadata) untouched.
 */
export function mergeCodexModels(
    catalog: readonly CodexModelSummary[] | undefined,
    extras: readonly CodexModelSummary[]
): CodexModelSummary[] {
    const models = catalog ? [...catalog] : []
    const known = new Set(models.map((model) => model.id.trim().toLowerCase()))
    for (const extra of extras) {
        const key = extra.id.trim().toLowerCase()
        if (known.has(key)) {
            continue
        }
        known.add(key)
        models.push(extra)
    }
    return models
}
