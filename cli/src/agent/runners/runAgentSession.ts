import type { AgentState, SessionPermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { AgentRegistry } from '@/agent/AgentRegistry';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentBackend, PromptContent } from '@/agent/types';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentFlavor, SessionEndReason } from '@hapi/protocol';
function emitReadyIfIdle(props: {
    queueSize: () => number;
    shouldExit: boolean;
    thinking: boolean;
    sendReady: () => void;
}): void {
    if (props.shouldExit) return;
    if (props.thinking) return;
    if (props.queueSize() > 0) return;
    props.sendReady();
}

export async function runAgentSession(opts: {
    agentType: string;
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: SessionPermissionMode;
    model?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local')
    const initialState: AgentState = {
        controlledByUser: false
    };
    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: opts.agentType,
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: opts.agentType,
            startedBy: opts.startedBy ?? 'terminal',
            workingDirectory,
            agentState: initialState
        });
    const { session, sessionInfo } = bootstrap;

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: false
    }));

    const messageQueue = new MessageQueue2<Record<string, never>>(() => hashObject({}));
    messageQueue.onBatchConsumed = (localIds) => session.emitMessagesConsumed(localIds);

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, {}, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[agent] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    let currentPermissionMode: SessionPermissionMode = opts.permissionMode ?? sessionInfo.permissionMode ?? 'default';

    const backend: AgentBackend = AgentRegistry.create(opts.agentType);
    await backend.initialize();

    const permissionAdapter = new PermissionAdapter(session, backend, () => currentPermissionMode);

    const happyServer = await startHappyServer(session, {
        skillLookup: {
            workingDirectory,
            flavor: opts.agentType
        }
    });
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(',')
    ]);
    const mcpServers = [
        {
            name: 'happy',
            command: bridgeCommand.command,
            args: bridgeCommand.args,
            env: []
        }
    ];

    const agentSessionId = opts.resumeSessionId && (backend as { supportsLoadSession?: () => boolean }).supportsLoadSession?.()
        ? await backend.loadSession({
            sessionId: opts.resumeSessionId,
            cwd: workingDirectory,
            mcpServers
        })
        : await backend.newSession({
            cwd: workingDirectory,
            mcpServers
        });
    if (opts.model && backend.setModel) {
        await backend.setModel(agentSessionId, opts.model, { flavor: opts.agentType as AgentFlavor });
    }

    if (opts.agentType === 'hermes') {
        session.rpcHandlerManager.registerHandler(RPC_METHODS.ListHermesModels, async () => {
            const metadata = backend.getSessionModelsMetadata?.(agentSessionId);
            return metadata
                ? { success: true, availableModels: metadata.availableModels, currentModelId: metadata.currentModelId }
                : { success: false, error: 'Hermes model metadata is not available' };
        });
    }

    let thinking = false;
    let shouldExit = false;
    let waitAbortController: AbortController | null = null;
    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode
        });
    };

    const resolvePermissionMode = (value: unknown): SessionPermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, opts.agentType)) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as SessionPermissionMode;
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.model !== undefined) {
            if (typeof config.model !== 'string' || !config.model.trim() || !backend.setModel) {
                throw new Error('Invalid or unsupported model');
            }
            await backend.setModel(agentSessionId, config.model, { flavor: opts.agentType as AgentFlavor });
        }

        syncKeepAlive();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                ...(typeof config.model === 'string' ? { model: config.model } : {})
            }
        };
    });

    syncKeepAlive();
    const keepAliveInterval = setInterval(() => {
        syncKeepAlive();
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const handleAbort = async () => {
        logger.debug('[ACP] Abort requested');
        await backend.cancelPrompt(agentSessionId);
        await permissionAdapter.cancelAll('User aborted');
        thinking = false;
        syncKeepAlive();
        sendReady();
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        await handleAbort();
    });

    const handleKillSession = async () => {
        if (shouldExit) return;
        shouldExit = true;
        await permissionAdapter.cancelAll('Session killed');
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    let sessionEndReason: SessionEndReason = 'completed';
    try {
        while (!shouldExit) {
            waitAbortController = new AbortController();
            const batch = await messageQueue.waitForMessagesAndGetAsString(waitAbortController.signal);
            waitAbortController = null;
            if (!batch) {
                if (shouldExit) {
                    break;
                }
                continue;
            }

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            thinking = true;
            syncKeepAlive();

            try {
                await backend.prompt(agentSessionId, promptContent, (message) => {
                    const converted = convertAgentMessage(message);
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                });
            } catch (error) {
                logger.warn('[ACP] Prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Agent prompt failed. Check logs for details.'
                });
            } finally {
                thinking = false;
                syncKeepAlive();
                await permissionAdapter.cancelAll('Prompt finished');
                emitReadyIfIdle({
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    thinking,
                    sendReady
                });
            }
        }
        if (shouldExit) {
            sessionEndReason = 'terminated';
        }
    } catch (error) {
        sessionEndReason = 'error';
        throw error;
    } finally {
        clearInterval(keepAliveInterval);
        await permissionAdapter.cancelAll('Session ended');
        session.sendSessionDeath(sessionEndReason);
        await session.flush();
        session.close();
        await backend.disconnect();
        happyServer.stop();
    }
}
