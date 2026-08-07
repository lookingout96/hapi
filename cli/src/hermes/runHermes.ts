import { logger } from '@/ui/logger'
import { runAgentSession } from '@/agent/runners/runAgentSession'
import { AgentRegistry } from '@/agent/AgentRegistry'
import { AcpSdkBackend } from '@/agent/backends/acp'
import { getInvokedCwd } from '@/utils/invokedCwd'

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
    const startedBy = opts.startedBy ?? 'terminal'
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    logger.debug(`[hermes] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}, cwd=${workingDirectory}`)
    AgentRegistry.register('hermes', () => new AcpSdkBackend({
        command: 'hermes',
        args: ['acp'],
        textChunkMode: 'delta',
        cwd: workingDirectory
    }))
    await runAgentSession({
        agentType: 'hermes',
        startedBy,
        startingMode: opts.startingMode,
        permissionMode: opts.permissionMode === 'default' ? opts.permissionMode : undefined,
        model: opts.model,
        resumeSessionId: opts.resumeSessionId,
        existingSessionId: opts.existingSessionId,
        workingDirectory
    })
}
