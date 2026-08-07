import type { AgentType } from './types'

export function shouldEnableHermesModelDiscovery(args: {
    agent: AgentType
    machineId: string | null
    cwd: string
    cwdExists: boolean | undefined
}): boolean {
    if (args.agent !== 'hermes') return false
    if (!args.machineId || args.cwd.length === 0) return false
    return args.cwdExists === true
}
