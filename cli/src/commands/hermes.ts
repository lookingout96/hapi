import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

const HERMES_PERMISSION_MODES = ['default'] as const

export const hermesCommand: CommandDefinition = {
    name: 'hermes',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseRemoteAgentCommandOptions(commandArgs, HERMES_PERMISSION_MODES)

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runHermes } = await import('@/hermes/runHermes')
            await runHermes(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
