import { logger } from '@/ui/logger'
import { runAgentSession } from '@/agent/runners/runAgentSession'

export async function runHermes(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: string
    model?: string
    modelReasoningEffort?: string | null
    resumeSessionId?: string
    existingSessionId?: string
    workingDirectory?: string
} = {}): Promise<void> {
    logger.debug(`[hermes] Starting with options: startedBy=${opts.startedBy}`)
    await runAgentSession({ agentType: 'hermes', startedBy: opts.startedBy })
}
