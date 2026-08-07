import { describe, expect, it } from 'vitest'
import { shouldEnableHermesModelDiscovery } from './hermesModelsGate'

describe('shouldEnableHermesModelDiscovery', () => {
    it('enables discovery only for Hermes with a machine and confirmed cwd', () => {
        expect(shouldEnableHermesModelDiscovery({
            agent: 'hermes', machineId: 'machine-1', cwd: '/project', cwdExists: true
        })).toBe(true)
        expect(shouldEnableHermesModelDiscovery({
            agent: 'opencode', machineId: 'machine-1', cwd: '/project', cwdExists: true
        })).toBe(false)
        expect(shouldEnableHermesModelDiscovery({
            agent: 'hermes', machineId: 'machine-1', cwd: '/project', cwdExists: undefined
        })).toBe(false)
    })
})
