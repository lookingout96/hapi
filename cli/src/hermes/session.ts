import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { HermesHookEvent, HermesMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class HermesSession extends AgentSessionBase<HermesMode> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;

    private hookEventHandlers: Array<(event: HermesHookEvent) => void> = [];

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<HermesMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
        modelReasoningEffort?: string | null;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'HermesSession',
            sessionIdLabel: 'OpenCode',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                hermesSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            modelReasoningEffort: opts.modelReasoningEffort
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.modelReasoningEffort = opts.modelReasoningEffort;
    }

    addHookEventHandler(cb: (event: HermesHookEvent) => void): void {
        this.hookEventHandlers.push(cb);
    }

    removeHookEventHandler(cb: (event: HermesHookEvent) => void): void {
        const index = this.hookEventHandlers.indexOf(cb);
        if (index !== -1) {
            this.hookEventHandlers.splice(index, 1);
        }
    }

    emitHookEvent(event: HermesHookEvent): void {
        for (const handler of this.hookEventHandlers) {
            handler(event);
        }
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: string | null): void => {
        this.model = model;
    };

    setModelReasoningEffort = (modelReasoningEffort: string | null): void => {
        this.modelReasoningEffort = modelReasoningEffort;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
