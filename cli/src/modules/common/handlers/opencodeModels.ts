import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listOpencodeModelsForCwd,
    listHermesModelsForCwd,
    type ListHermesModelsForCwdRequest,
    type ListHermesModelsForCwdResponse,
    type ListOpencodeModelsForCwdRequest,
    type ListOpencodeModelsForCwdResponse
} from '../opencodeModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerOpencodeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListOpencodeModelsForCwdRequest, ListOpencodeModelsForCwdResponse>(
        RPC_METHODS.ListOpencodeModelsForCwd,
        async (data) => {
            logger.debug('List OpenCode models for cwd request', { cwd: data?.cwd });

            try {
                const cwd = typeof data?.cwd === 'string' ? data.cwd : '';
                return await listOpencodeModelsForCwd(cwd);
            } catch (error) {
                logger.debug('Failed to list OpenCode models:', error);
                return rpcError(getErrorMessage(error, 'Failed to list OpenCode models'));
            }
        }
    );
    rpcHandlerManager.registerHandler<ListHermesModelsForCwdRequest, ListHermesModelsForCwdResponse>(
        RPC_METHODS.ListHermesModelsForCwd,
        async (data) => {
            logger.debug('List Hermes models for cwd request', { cwd: data?.cwd });
            try {
                return await listHermesModelsForCwd(typeof data?.cwd === 'string' ? data.cwd : '');
            } catch (error) {
                return rpcError(getErrorMessage(error, 'Failed to list Hermes models'));
            }
        }
    );
}
