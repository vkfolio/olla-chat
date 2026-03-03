import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
    AssistantMode,
    AttachmentMeta,
    ClientRequest,
    ContextPolicy,
    ContextScope,
    ModelCapability,
    ServerEvent,
    SessionRecord
} from '../types/protocol';
import { ContextEngine } from './ContextEngine';
import { debugError, debugLog } from './DebugLogger';
import { createId } from './id';
import { ModelService } from './ModelService';
import { SessionStore } from './SessionStore';
import { PendingApprovalAction, ToolRuntime } from './ToolRuntime';

interface PendingContinuation {
    actionId: string;
    sessionId: string;
    turnId: string;
    mode: AssistantMode;
    model: string;
    temperature: number;
    messages: BaseMessage[];
    assistantAccumulated: string;
    toolCallId: string;
}

interface SelectionSnapshot {
    sessionId: string;
    turnId: string;
    uri: string;
    filePath: string;
    languageId: string;
    start: vscode.Position;
    end: vscode.Position;
    startOffset: number;
    selectedText: string;
    rangeLabel: string;
}

interface SelectionUndoState {
    sessionId: string;
    turnId: string;
    uri: string;
    filePath: string;
    rangeLabel: string;
    anchorOffset: number;
    beforeText: string;
    afterText: string;
    beforeVersion: number;
    afterVersion: number;
}

type EmitFn = (event: ServerEvent) => void;

export class ConversationOrchestrator {
    private readonly sessionStore: SessionStore;
    private readonly modelService: ModelService;
    private readonly contextEngine: ContextEngine;
    private readonly toolRuntime: ToolRuntime;
    private readonly pendingContinuations = new Map<string, PendingContinuation>();
    private readonly selectionSnapshots = new Map<string, SelectionSnapshot>();
    private readonly pendingSelectionReplace = new Map<string, { sessionId: string; turnId: string; text: string }>();
    private readonly selectionReplaceIntent = new Map<string, boolean>();
    private readonly selectionUndoState = new Map<string, SelectionUndoState>();
    private activeSessionId = '';

    constructor(
        context: vscode.ExtensionContext,
        private readonly emit: EmitFn
    ) {
        this.sessionStore = new SessionStore(context);
        this.modelService = new ModelService();
        this.contextEngine = new ContextEngine();
        this.toolRuntime = new ToolRuntime();
    }

    public async initialize(): Promise<void> {
        const sessions = await this.sessionStore.listSessions();
        const model = await this.resolveAvailableModel(this.modelService.getConfiguredModel());
        debugLog('Orchestrator', 'Initialize called', {
            existingSessions: sessions.length,
            preferredModel: this.modelService.getConfiguredModel(),
            resolvedModel: model
        });
        if (sessions.length === 0) {
            const created = await this.sessionStore.createSession(model, this.defaultMode());
            this.activeSessionId = created.id;
            debugLog('Orchestrator', 'Created initial session', {
                sessionId: created.id,
                mode: created.mode,
                model: created.model
            });
            return;
        }
        const active = await this.sessionStore.getActiveSessionId();
        this.activeSessionId = active && sessions.some((session) => session.id === active)
            ? active
            : sessions[0].id;
        await this.sessionStore.setActiveSessionId(this.activeSessionId);
        debugLog('Orchestrator', 'Initialization complete', { activeSessionId: this.activeSessionId });
    }

    public async handleClientRequest(request: ClientRequest): Promise<void> {
        debugLog('Orchestrator', `Handling request ${request.type}`);
        switch (request.type) {
            case 'bootstrap':
                await this.emitBootstrap();
                return;
            case 'send_turn':
                await this.handleSendTurn(request);
                return;
            case 'set_model':
                await this.modelService.setConfiguredModel(request.model);
                if (this.activeSessionId) {
                    const active = await this.sessionStore.getSession(this.activeSessionId);
                    if (active) {
                        const updated = await this.sessionStore.setSessionModeAndModel(active.id, active.mode, request.model);
                        if (updated) {
                            this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
                        }
                    }
                }
                await this.emitModels();
                return;
            case 'set_temperature':
                await this.modelService.setConfiguredTemperature(request.temperature);
                if (this.activeSessionId) {
                    const updated = await this.sessionStore.setSessionTemperature(
                        this.activeSessionId,
                        this.clampTemperature(request.temperature)
                    );
                    if (updated) {
                        this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
                    }
                }
                this.emit({ type: 'temperature_updated', temperature: this.clampTemperature(request.temperature) });
                return;
            case 'set_context_policy':
                if (this.activeSessionId) {
                    const updated = await this.sessionStore.setSessionContextPolicy(this.activeSessionId, request.contextPolicy);
                    if (updated) {
                        this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
                    }
                }
                return;
            case 'set_context_scope':
                if (this.activeSessionId) {
                    const updated = await this.sessionStore.setSessionContextScope(this.activeSessionId, request.contextScope);
                    if (updated) {
                        this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
                    }
                }
                return;
            case 'refresh_models':
                await this.emitModels();
                return;
            case 'attach_picker':
                await this.handleAttachPicker(request.sessionId);
                return;
            case 'detach_attachment':
                await this.handleDetachAttachment(request.sessionId, request.attachmentId);
                return;
            case 'approve_action':
                await this.handleApproval(request.sessionId, request.actionId, request.approved);
                return;
            case 'apply_selection_replace':
                await this.handleApplySelectionReplace(request.sessionId, request.turnId);
                return;
            case 'undo_selection_replace':
                await this.handleUndoSelectionReplace(request.sessionId, request.turnId);
                return;
            case 'session_create':
                await this.handleCreateSession(request.mode ?? this.defaultMode());
                return;
            case 'session_switch':
                await this.handleSwitchSession(request.sessionId);
                return;
            case 'session_rename':
                await this.handleRenameSession(request.sessionId, request.title);
                return;
            case 'session_delete':
                await this.handleDeleteSession(request.sessionId);
                return;
            case 'open_settings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'olla-chat');
                return;
            default:
                this.emit({ type: 'error', message: 'Unsupported client request.' });
                return;
        }
    }

    private async emitBootstrap(): Promise<void> {
        const sessions = await this.sessionStore.listSessions();
        const models = await this.modelService.listModels();
        const currentModel = await this.resolveAvailableModel(this.modelService.getConfiguredModel(), models);
        this.emit({
            type: 'bootstrap',
            sessions,
            activeSessionId: this.activeSessionId,
            models,
            currentModel
        });
    }

    private async emitModels(): Promise<void> {
        const models = await this.modelService.listModels();
        const currentModel = await this.resolveAvailableModel(this.modelService.getConfiguredModel(), models);
        this.emit({
            type: 'models_updated',
            models,
            currentModel
        });
    }

    private async handleCreateSession(mode: AssistantMode): Promise<void> {
        const model = await this.resolveAvailableModel(this.modelService.getConfiguredModel());
        const session = await this.sessionStore.createSession(model, mode);
        this.activeSessionId = session.id;
        await this.sessionStore.setActiveSessionId(session.id);
        await this.emitBootstrap();
    }

    private async handleSwitchSession(sessionId: string): Promise<void> {
        const session = await this.sessionStore.getSession(sessionId);
        if (!session) {
            this.emit({ type: 'error', message: `Unknown session: ${sessionId}` });
            return;
        }
        this.activeSessionId = sessionId;
        await this.sessionStore.setActiveSessionId(sessionId);
        await this.emitBootstrap();
    }

    private async handleRenameSession(sessionId: string, title: string): Promise<void> {
        const session = await this.sessionStore.renameSession(sessionId, title);
        if (!session) {
            this.emit({ type: 'error', message: `Cannot rename unknown session: ${sessionId}` });
            return;
        }
        this.emit({ type: 'session_updated', session, activeSessionId: this.activeSessionId });
    }

    private async handleDeleteSession(sessionId: string): Promise<void> {
        this.clearSelectionStateForSession(sessionId);
        await this.sessionStore.deleteSession(sessionId);
        if (this.activeSessionId === sessionId) {
            const sessions = await this.sessionStore.listSessions();
            if (sessions.length > 0) {
                this.activeSessionId = sessions[0].id;
            } else {
                const model = await this.resolveAvailableModel(this.modelService.getConfiguredModel());
                const created = await this.sessionStore.createSession(model, 'ask');
                this.activeSessionId = created.id;
            }
            await this.sessionStore.setActiveSessionId(this.activeSessionId);
        }
        this.emit({ type: 'session_deleted', sessionId, activeSessionId: this.activeSessionId });
        await this.emitBootstrap();
    }

    private async handleAttachPicker(sessionId: string): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: 'Attach to Chat'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const session = await this.sessionStore.getSession(sessionId);
        if (!session) {
            return;
        }
        const nextAttachments = [...session.attachments];
        for (const uri of picked) {
            nextAttachments.push(this.toAttachment(uri.fsPath));
        }
        const updated = await this.sessionStore.setAttachments(sessionId, dedupeAttachments(nextAttachments));
        if (updated) {
            this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
        }
    }

    private async handleDetachAttachment(sessionId: string, attachmentId: string): Promise<void> {
        const session = await this.sessionStore.getSession(sessionId);
        if (!session) {
            return;
        }
        const updated = await this.sessionStore.setAttachments(
            sessionId,
            session.attachments.filter((attachment) => attachment.id !== attachmentId)
        );
        if (updated) {
            this.emit({ type: 'session_updated', session: updated, activeSessionId: this.activeSessionId });
        }
    }

    private async handleSendTurn(request: Extract<ClientRequest, { type: 'send_turn' }>): Promise<void> {
        const session = await this.ensureSession(request.sessionId);
        if (!session) {
            this.emit({ type: 'error', message: 'No available session to handle turn.' });
            return;
        }
        this.clearPendingSelectionRequestsForSession(session.id);

        const mode = request.mode ?? session.mode;
        const requestedModel = request.model ?? session.model ?? this.modelService.getConfiguredModel();
        const temperature = this.clampTemperature(request.temperature ?? session.temperature ?? this.modelService.getConfiguredTemperature());
        const contextPolicy = request.contextPolicy ?? session.contextPolicy ?? this.defaultContextPolicy();
        const contextScope = request.contextScope ?? session.contextScope ?? this.defaultContextScope();
        const models = await this.modelService.listModels();
        const model = await this.resolveAvailableModel(requestedModel, models);
        const turnId = createId('turn');
        debugLog('Orchestrator', 'Turn requested', {
            sessionId: session.id,
            turnId,
            mode,
            requestedModel,
            resolvedModel: model,
            temperature,
            contextPolicy,
            contextScope,
            textLength: request.text.length,
            attachments: session.attachments.length
        });

        let nextSession = await this.sessionStore.setSessionModeAndModel(session.id, mode, model);
        if (!nextSession) {
            nextSession = session;
        }
        nextSession = await this.sessionStore.setSessionTemperature(session.id, temperature) ?? nextSession;
        nextSession = await this.sessionStore.setSessionContextPolicy(session.id, contextPolicy) ?? nextSession;
        nextSession = await this.sessionStore.setSessionContextScope(session.id, contextScope) ?? nextSession;

        nextSession = await this.sessionStore.appendMessage(session.id, {
            role: 'user',
            content: request.text
        }) ?? nextSession;

        if (nextSession.messages.length === 1 || nextSession.title === 'New Chat') {
            const nextTitle = request.text.trim().slice(0, 48) || 'New Chat';
            nextSession = await this.sessionStore.renameSession(session.id, nextTitle) ?? nextSession;
        }

        this.activeSessionId = nextSession.id;
        await this.sessionStore.setActiveSessionId(this.activeSessionId);

        this.emit({ type: 'session_updated', session: nextSession, activeSessionId: this.activeSessionId });
        this.emit({ type: 'turn_started', sessionId: nextSession.id, turnId, mode });
        const selectionKey = this.selectionKey(nextSession.id, turnId);
        const editIntent = this.shouldTreatAsSelectionEditRequest(request.text);
        const allowCursorInsert = editIntent && (mode === 'agent' || mode === 'ask');
        const selectionSnapshot = this.captureSelectionSnapshot(nextSession.id, turnId, allowCursorInsert);
        if (selectionSnapshot) {
            this.selectionSnapshots.set(selectionKey, selectionSnapshot);
            this.selectionReplaceIntent.set(selectionKey, allowCursorInsert);
            debugLog('Orchestrator', 'Captured selection snapshot', {
                sessionId: nextSession.id,
                turnId,
                filePath: selectionSnapshot.filePath,
                languageId: selectionSnapshot.languageId,
                range: selectionSnapshot.rangeLabel,
                chars: selectionSnapshot.selectedText.length,
                editIntent: allowCursorInsert
            });
            this.emit({
                type: 'selection_context',
                sessionId: nextSession.id,
                turnId,
                filePath: selectionSnapshot.filePath,
                range: selectionSnapshot.rangeLabel,
                chars: selectionSnapshot.selectedText.length
            });
        } else {
            this.selectionReplaceIntent.delete(selectionKey);
        }

        if (model !== requestedModel) {
            this.emit({
                type: 'thinking_summary',
                sessionId: nextSession.id,
                turnId,
                text: `Requested model "${requestedModel}" is unavailable. Switched to "${model}".`
            });
            await this.pushTimeline(nextSession.id, {
                type: 'system',
                status: 'info',
                turnId,
                title: 'Model auto-fallback',
                detail: `Switched from "${requestedModel}" to "${model}" because the requested model was not installed.`
            });
            this.emit({
                type: 'models_updated',
                models,
                currentModel: model
            });
        }

        this.emit({
            type: 'trace_stream',
            sessionId: nextSession.id,
            turnId,
            level: 'thinking',
            text: `Mode: ${mode} | Model: ${model} | Temperature: ${temperature.toFixed(1)}`
        });

        if (mode === 'plan') {
            await this.emitPlanScaffold(nextSession.id, turnId, request.text);
        }

        await this.upsertTurnPhase(nextSession.id, turnId, 'analyzing_request', {
            type: 'thinking',
            status: 'running',
            title: 'Analyzing request',
            detail: `Mode: ${mode}. Preparing context bundle.`
        });

        try {
            const context = await this.contextEngine.buildContext(
                request.text,
                nextSession.attachments,
                {
                    mode,
                    policy: contextPolicy,
                    scope: contextScope
                }
            );
            await this.upsertTurnPhase(nextSession.id, turnId, 'analyzing_request', {
                type: 'thinking',
                status: 'success',
                title: 'Analyzing request',
                detail: `Prepared context with ${context.citations.length} source reference(s).`
            });
            this.emit({
                type: 'context_used',
                sessionId: nextSession.id,
                turnId,
                scopes: context.scopesUsed,
                citations: context.citations
            });
            this.emit({
                type: 'trace_stream',
                sessionId: nextSession.id,
                turnId,
                level: 'thinking',
                text: `Context scopes: ${context.scopesUsed.length > 0 ? context.scopesUsed.join(', ') : 'None'}`
            });
            debugLog('Orchestrator', 'Context prepared', {
                sessionId: nextSession.id,
                turnId,
                scopesUsed: context.scopesUsed,
                citations: context.citations.length,
                contextLength: context.text.length
            });

            const history = nextSession.messages.slice(-16);
            const imageAttachments = nextSession.attachments.filter((attachment) => attachment.kind === 'image' && !!attachment.imageBase64);
            const selectionDirective = selectionSnapshot && this.selectionReplaceIntent.get(selectionKey)
                ? (
                    selectionSnapshot.selectedText.length > 0
                        ? `Selection edit directive: transform only the selected text in ${selectionSnapshot.languageId}. Return only replacement text with no extra commentary, headers, or code fences.`
                        : `Editor insert directive: generate ${selectionSnapshot.languageId} content to insert at cursor. Return only the insertable code/text with no extra commentary, headers, or code fences.`
                )
                : '';
            debugLog('Orchestrator', 'Composing model messages', {
                sessionId: nextSession.id,
                turnId,
                historyMessages: history.length,
                imageAttachments: imageAttachments.length,
                selectionDirective: selectionDirective.length > 0
            });

            const messages: BaseMessage[] = [
                new SystemMessage(this.systemPrompt(mode, model)),
                ...history.map((message) => (
                    message.role === 'assistant'
                        ? new AIMessage(message.content)
                        : new HumanMessage(message.content)
                )),
                imageAttachments.length > 0
                    ? new HumanMessage({
                        content: [
                            {
                                type: 'text',
                                text:
                                    `${request.text}\n\n` +
                                    `${selectionDirective ? `${selectionDirective}\n\n` : ''}` +
                                    `Use this context bundle when relevant:\n${context.text}\n\n` +
                                    `Citations:\n- ${context.citations.join('\n- ')}`
                            },
                            ...imageAttachments.map((attachment) => ({
                                type: 'image_url',
                                image_url: `data:${attachment.mimeType ?? 'image/png'};base64,${attachment.imageBase64}`
                            }))
                        ] as any
                    } as any)
                    : new HumanMessage(
                        `${request.text}\n\n` +
                        `${selectionDirective ? `${selectionDirective}\n\n` : ''}` +
                        `Use this context bundle when relevant:\n${context.text}\n\n` +
                        `Citations:\n- ${context.citations.join('\n- ')}`
                    )
            ];

            await this.runModelLoop({
                sessionId: nextSession.id,
                turnId,
                mode,
                model,
                temperature,
                messages,
                assistantAccumulated: '',
                retries: 0
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            debugError('Orchestrator', 'Context preparation failed', error, {
                sessionId: nextSession.id,
                turnId
            });
            await this.upsertTurnPhase(nextSession.id, turnId, 'analyzing_request', {
                type: 'thinking',
                status: 'error',
                title: 'Analyzing request',
                detail: message
            });
            await this.failTurn(nextSession.id, turnId, `Could not prepare project context. ${message}`);
        }
    }

    private async runModelLoop(state: {
        sessionId: string;
        turnId: string;
        mode: AssistantMode;
        model: string;
        temperature: number;
        messages: BaseMessage[];
        assistantAccumulated: string;
        retries: number;
    }): Promise<void> {
        try {
            const capabilities = this.modelService.withCapabilities(state.model);
            const allowTools = state.mode !== 'ask' && capabilities.toolCalling;
            const toolSchemas = this.toolRuntime.getToolSchemas(state.mode);
            debugLog('Orchestrator', 'Running model loop', {
                sessionId: state.sessionId,
                turnId: state.turnId,
                mode: state.mode,
                model: state.model,
                temperature: state.temperature,
                allowTools,
                toolSchemaCount: toolSchemas.length,
                retries: state.retries
            });

            if (!capabilities.toolCalling && state.mode === 'agent') {
                this.emit({
                    type: 'thinking_summary',
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    text: 'Selected model has weak tool-calling support. Running in answer-only fallback.'
                });
                await this.pushTimeline(state.sessionId, {
                    type: 'system',
                    status: 'info',
                    turnId: state.turnId,
                    title: 'Model capability fallback',
                    detail: `${state.model} does not appear tool-first. Agent tools were skipped.`
                });
            }

            let chatModel: unknown = this.modelService.createChatModel(state.model, state.temperature);
            if (allowTools && toolSchemas.length > 0) {
                chatModel = (chatModel as { bindTools: (schemas: unknown[]) => unknown }).bindTools(toolSchemas);
            }

            const stream = await (chatModel as { stream: (messages: BaseMessage[]) => Promise<AsyncIterable<unknown>> }).stream(state.messages);
            let fullResponse = '';
            const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
            let insideThink = false;
            let streamedChars = 0;
            let streamedChunks = 0;

            for await (const rawChunk of stream) {
                const chunk = rawChunk as { content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }> };
                const delta = this.extractContent(chunk.content);
                if (delta.length > 0) {
                    let output = delta;
                    if (output.includes('<think>')) {
                        insideThink = true;
                        output = output.substring(0, output.indexOf('<think>'));
                        this.emit({ type: 'thinking_summary', sessionId: state.sessionId, turnId: state.turnId, text: 'Model is reasoning about next actions.' });
                        this.emit({
                            type: 'trace_stream',
                            sessionId: state.sessionId,
                            turnId: state.turnId,
                            level: 'thinking',
                            text: 'Model is reasoning about next actions.'
                        });
                    }
                    if (insideThink) {
                        if (delta.includes('</think>')) {
                            insideThink = false;
                            output = delta.substring(delta.indexOf('</think>') + '</think>'.length);
                        } else {
                            continue;
                        }
                    }
                    output = output.replace(/<\/?think>/g, '');
                    if (output.length > 0) {
                        fullResponse += output;
                        streamedChunks += 1;
                        streamedChars += output.length;
                        this.emit({
                            type: 'token_stream',
                            sessionId: state.sessionId,
                            turnId: state.turnId,
                            delta: output
                        });
                    }
                }
                if (Array.isArray(chunk.tool_calls)) {
                    for (const call of chunk.tool_calls) {
                        if (!call || !call.name) {
                            continue;
                        }
                        toolCalls.push({
                            id: call.id ?? createId('tool'),
                            name: call.name,
                            args: call.args
                        });
                    }
                }
            }
            debugLog('Orchestrator', 'Model stream complete', {
                sessionId: state.sessionId,
                turnId: state.turnId,
                streamedChunks,
                streamedChars,
                toolCalls: toolCalls.map((call) => call.name)
            });

            const cleanedResponse = this.stripThinkBlocks(fullResponse).trim();
            const accumulated = [state.assistantAccumulated, cleanedResponse].filter((entry) => entry.length > 0).join('\n');
            const aiMessage = new AIMessage({
                content: cleanedResponse,
                tool_calls: toolCalls
            } as any);
            const nextMessages = [...state.messages, aiMessage];

            if (toolCalls.length === 0 || !allowTools) {
                await this.finishTurn(state.sessionId, state.turnId, accumulated, state.mode);
                return;
            }

            this.emit({
                type: 'subagent_event',
                sessionId: state.sessionId,
                turnId: state.turnId,
                status: 'start',
                text: `Executing ${toolCalls.length} tool call(s).`
            });
            this.emit({
                type: 'trace_stream',
                sessionId: state.sessionId,
                turnId: state.turnId,
                level: 'tool',
                text: `Executing ${toolCalls.length} tool call(s).`
            });

            await this.pushTimeline(state.sessionId, {
                type: 'subagent',
                status: 'running',
                turnId: state.turnId,
                title: 'Sub-agent execution',
                detail: `Running ${toolCalls.length} tool call(s).`
            });

            const workingMessages = [...nextMessages];
            for (const toolCall of toolCalls) {
                debugLog('Orchestrator', 'Executing model-requested tool', {
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    toolName: toolCall.name,
                    toolCallId: toolCall.id
                });
                this.emit({
                    type: 'tool_event',
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    toolName: toolCall.name,
                    status: 'start'
                });
                this.emit({
                    type: 'trace_stream',
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    level: 'tool',
                    text: `Tool start: ${toolCall.name}`
                });
                const execution = await this.toolRuntime.executeToolCall(
                    state.sessionId,
                    toolCall.id,
                    toolCall.name,
                    toolCall.args
                );

                if (execution.kind === 'completed') {
                    debugLog('Orchestrator', 'Tool execution completed', {
                        sessionId: state.sessionId,
                        turnId: state.turnId,
                        toolName: toolCall.name,
                        outputLength: execution.output.length
                    });
                    workingMessages.push(new ToolMessage({
                        tool_call_id: toolCall.id,
                        content: execution.output
                    }));
                    this.emit({
                        type: 'tool_event',
                        sessionId: state.sessionId,
                        turnId: state.turnId,
                        toolName: toolCall.name,
                        status: 'output',
                        text: execution.output.slice(0, 5000)
                    });
                    this.emit({
                        type: 'trace_stream',
                        sessionId: state.sessionId,
                        turnId: state.turnId,
                        level: 'tool',
                        text: `Tool output (${toolCall.name}): ${execution.output.slice(0, 220)}`
                    });
                    this.emit({
                        type: 'tool_event',
                        sessionId: state.sessionId,
                        turnId: state.turnId,
                        toolName: toolCall.name,
                        status: 'end'
                    });
                    await this.pushTimeline(state.sessionId, {
                        type: 'tool',
                        status: 'success',
                        turnId: state.turnId,
                        title: `Tool: ${toolCall.name}`,
                        detail: execution.output.slice(0, 500)
                    });
                    continue;
                }

                this.pendingContinuations.set(execution.action.id, {
                    actionId: execution.action.id,
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    mode: state.mode,
                    model: state.model,
                    temperature: state.temperature,
                    messages: workingMessages,
                    assistantAccumulated: accumulated,
                    toolCallId: execution.action.toolCallId
                });
                debugLog('Orchestrator', 'Tool execution requires approval', {
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    actionId: execution.action.id,
                    actionType: execution.action.type
                });

                await this.emitApprovalEvents(state.sessionId, state.turnId, execution.action);
                return;
            }

            this.emit({
                type: 'subagent_event',
                sessionId: state.sessionId,
                turnId: state.turnId,
                status: 'end',
                text: 'Tool execution complete. Synthesizing response.'
            });
            this.emit({
                type: 'trace_stream',
                sessionId: state.sessionId,
                turnId: state.turnId,
                level: 'tool',
                text: 'Tool execution complete. Synthesizing response.'
            });

            await this.runModelLoop({
                ...state,
                messages: workingMessages,
                assistantAccumulated: accumulated,
                retries: state.retries
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            debugError('Orchestrator', 'Model loop failed', error, {
                sessionId: state.sessionId,
                turnId: state.turnId,
                model: state.model,
                retries: state.retries
            });
            if (this.isModelNotFoundError(message) && state.retries < 1) {
                const fallback = await this.resolveAvailableModel(this.modelService.getConfiguredModel());
                if (fallback !== state.model) {
                    this.emit({
                        type: 'thinking_summary',
                        sessionId: state.sessionId,
                        turnId: state.turnId,
                        text: `Model "${state.model}" failed. Retrying with "${fallback}".`
                    });
                    await this.pushTimeline(state.sessionId, {
                        type: 'system',
                        status: 'info',
                        turnId: state.turnId,
                        title: 'Model retry fallback',
                        detail: `Retrying the turn with "${fallback}" after "${state.model}" was unavailable.`
                    });
                    await this.runModelLoop({
                        ...state,
                        model: fallback,
                        temperature: state.temperature,
                        retries: state.retries + 1
                    });
                    return;
                }
            }
            await this.failTurn(
                state.sessionId,
                state.turnId,
                `Unable to run the model "${state.model}". ${message}\n\n` +
                'Check installed models with `ollama list` and pull one with `ollama pull <model>`.'
            );
        }
    }

    private async finishTurn(sessionId: string, turnId: string, assistantContent: string, mode: AssistantMode): Promise<void> {
        const responseText = assistantContent.length > 0 ? assistantContent : 'Done.';
        debugLog('Orchestrator', 'Finishing turn', {
            sessionId,
            turnId,
            mode,
            responseLength: responseText.length
        });
        await this.sessionStore.closeRunningTimelineForTurn(sessionId, turnId, 'success');
        let nextSession = await this.sessionStore.appendMessage(sessionId, {
            role: 'assistant',
            content: responseText
        });
        if (!nextSession) {
            return;
        }
        nextSession = await this.sessionStore.appendTimeline(sessionId, {
            type: 'system',
            status: 'success',
            turnId,
            title: 'Turn complete',
            detail: 'Assistant response finalized.'
        }) ?? nextSession;

        this.emit({
            type: 'session_updated',
            session: nextSession,
            activeSessionId: this.activeSessionId
        });

        await this.handleSelectionReplacementAfterTurn(sessionId, turnId, mode, responseText);
        this.emit({ type: 'turn_completed', sessionId, turnId });
    }

    private async handleSelectionReplacementAfterTurn(
        sessionId: string,
        turnId: string,
        mode: AssistantMode,
        responseText: string
    ): Promise<void> {
        const key = this.selectionKey(sessionId, turnId);
        const snapshot = this.selectionSnapshots.get(key);
        const shouldReplace = this.selectionReplaceIntent.get(key) ?? false;
        debugLog('Orchestrator', 'Evaluating post-turn selection replacement', {
            sessionId,
            turnId,
            mode,
            hasSnapshot: !!snapshot,
            responseLength: responseText.length,
            shouldReplace
        });
        if (!snapshot || responseText.trim().length === 0 || !shouldReplace) {
            this.selectionSnapshots.delete(key);
            this.pendingSelectionReplace.delete(key);
            this.selectionReplaceIntent.delete(key);
            return;
        }
        const replacementCandidate = this.normalizeReplacementForEditor(responseText, snapshot);
        if (!this.isLikelyEditorReplacement(replacementCandidate, snapshot)) {
            debugLog('Orchestrator', 'Skipping selection replacement due to low-confidence content', {
                sessionId,
                turnId,
                filePath: snapshot.filePath,
                languageId: snapshot.languageId,
                candidateLength: replacementCandidate.length
            });
            this.selectionSnapshots.delete(key);
            this.pendingSelectionReplace.delete(key);
            this.selectionReplaceIntent.delete(key);
            this.emit({
                type: 'selection_replace_failed',
                sessionId,
                turnId,
                message: `Model returned non-${snapshot.languageId} replacement content. Ask again with "return only ${snapshot.languageId} code".`
            });
            return;
        }

        if (mode === 'agent') {
            await this.applySelectionReplacement(sessionId, turnId, replacementCandidate, 'agent_auto');
            return;
        }

        if (mode === 'ask') {
            this.pendingSelectionReplace.set(key, { sessionId, turnId, text: replacementCandidate });
            debugLog('Orchestrator', 'Queued ask-mode selection replacement approval', {
                sessionId,
                turnId,
                filePath: snapshot.filePath,
                range: snapshot.rangeLabel
            });
            this.emit({
                type: 'selection_replace_ready',
                sessionId,
                turnId,
                filePath: snapshot.filePath,
                range: snapshot.rangeLabel
            });
            return;
        }

        this.selectionSnapshots.delete(key);
        this.selectionReplaceIntent.delete(key);
    }

    private async handleApplySelectionReplace(sessionId: string, turnId: string): Promise<void> {
        const key = this.selectionKey(sessionId, turnId);
        const pending = this.pendingSelectionReplace.get(key);
        debugLog('Orchestrator', 'Apply selection replacement requested', {
            sessionId,
            turnId,
            pending: !!pending
        });
        if (!pending) {
            this.emit({
                type: 'selection_replace_failed',
                sessionId,
                turnId,
                message: 'No pending selection replacement found for this turn.'
            });
            return;
        }
        await this.applySelectionReplacement(sessionId, turnId, pending.text, 'ask_manual');
    }

    private async handleUndoSelectionReplace(sessionId: string, turnId: string): Promise<void> {
        const key = this.selectionKey(sessionId, turnId);
        const state = this.selectionUndoState.get(key);
        debugLog('Orchestrator', 'Undo selection replacement requested', {
            sessionId,
            turnId,
            hasUndoState: !!state
        });
        if (!state) {
            this.emit({
                type: 'selection_replace_failed',
                sessionId,
                turnId,
                message: 'Nothing to undo for this turn.'
            });
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(state.uri));
            const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
            const targetRange = this.resolveUndoRange(document, state);
            if (!targetRange) {
                debugLog('Orchestrator', 'Undo range not found, attempting editor undo fallback', {
                    sessionId,
                    turnId,
                    filePath: state.filePath,
                    documentVersion: document.version,
                    expectedAfterVersion: state.afterVersion
                });
                const beforeVersion = document.version;
                await vscode.commands.executeCommand('undo');
                const afterVersion = editor.document.version;
                if (afterVersion !== beforeVersion) {
                    this.selectionUndoState.delete(key);
                    this.emit({
                        type: 'selection_undone',
                        sessionId,
                        turnId,
                        filePath: state.filePath
                    });
                    return;
                }
                this.emit({
                    type: 'selection_replace_failed',
                    sessionId,
                    turnId,
                    message: 'Unable to locate the generated text to undo. The file may have changed.'
                });
                return;
            }
            const applied = await editor.edit((editBuilder) => {
                editBuilder.replace(targetRange, state.beforeText);
            }, { undoStopBefore: true, undoStopAfter: true });
            if (!applied) {
                this.emit({
                    type: 'selection_replace_failed',
                    sessionId,
                    turnId,
                    message: 'VS Code rejected the undo edit. Try editor undo (Ctrl+Z).'
                });
                return;
            }
            this.selectionUndoState.delete(key);
            debugLog('Orchestrator', 'Selection replacement undone', {
                sessionId,
                turnId,
                filePath: state.filePath
            });
            this.emit({
                type: 'selection_undone',
                sessionId,
                turnId,
                filePath: state.filePath
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            debugError('Orchestrator', 'Undo selection replacement failed', error, {
                sessionId,
                turnId
            });
            this.emit({
                type: 'selection_replace_failed',
                sessionId,
                turnId,
                message
            });
        }
    }

    private async applySelectionReplacement(
        sessionId: string,
        turnId: string,
        replacementText: string,
        mode: 'agent_auto' | 'ask_manual'
    ): Promise<void> {
        const key = this.selectionKey(sessionId, turnId);
        const emitFailure = (message: string) => {
            debugLog('Orchestrator', 'Selection replacement failed', {
                sessionId,
                turnId,
                mode,
                message
            });
            this.emit({
                type: 'selection_replace_failed',
                sessionId,
                turnId,
                message
            });
            if (mode === 'agent_auto') {
                this.selectionSnapshots.delete(key);
                this.pendingSelectionReplace.delete(key);
                this.selectionReplaceIntent.delete(key);
            }
        };
        const snapshot = this.selectionSnapshots.get(key);
        if (!snapshot) {
            emitFailure('No selection snapshot found for this turn.');
            return;
        }
        const normalizedReplacement = this.normalizeReplacementForEditor(replacementText, snapshot);
        if (normalizedReplacement.length === 0) {
            emitFailure('Model response did not contain usable replacement content.');
            return;
        }
        if (!this.isLikelyEditorReplacement(normalizedReplacement, snapshot)) {
            emitFailure(`Model returned non-${snapshot.languageId} replacement content.`);
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(snapshot.uri));
            const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
            const targetRange = this.resolveSelectionRange(document, snapshot);
            if (!targetRange) {
                emitFailure('Original selection no longer matches the document. Re-select text and retry.');
                return;
            }
            const replacementForDocument = this.normalizeTextForDocumentEol(normalizedReplacement, document);

            const beforeText = document.getText(targetRange);
            const anchorOffset = document.offsetAt(targetRange.start);
            const beforeVersion = document.version;
            const applied = await editor.edit((editBuilder) => {
                editBuilder.replace(targetRange, replacementForDocument);
            }, { undoStopBefore: true, undoStopAfter: true });

            if (!applied) {
                emitFailure('VS Code rejected the replacement edit.');
                return;
            }

            this.pendingSelectionReplace.delete(key);
            this.selectionSnapshots.delete(key);
            this.selectionReplaceIntent.delete(key);
            this.selectionUndoState.set(key, {
                sessionId,
                turnId,
                uri: snapshot.uri,
                filePath: snapshot.filePath,
                rangeLabel: snapshot.rangeLabel,
                anchorOffset,
                beforeText,
                afterText: replacementForDocument,
                beforeVersion,
                afterVersion: editor.document.version
            });
            debugLog('Orchestrator', 'Selection replacement applied', {
                sessionId,
                turnId,
                filePath: snapshot.filePath,
                range: snapshot.rangeLabel,
                mode,
                replacementLength: replacementForDocument.length
            });
            this.emit({
                type: 'selection_replaced',
                sessionId,
                turnId,
                filePath: snapshot.filePath,
                range: snapshot.rangeLabel,
                mode
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            debugError('Orchestrator', 'Selection replacement threw error', error, {
                sessionId,
                turnId,
                mode
            });
            emitFailure(message);
        }
    }

    private async handleApproval(sessionId: string, actionId: string, approved: boolean): Promise<void> {
        debugLog('Orchestrator', 'Approval decision received', { sessionId, actionId, approved });
        const continuation = this.pendingContinuations.get(actionId);
        if (!continuation) {
            this.emit({
                type: 'error',
                sessionId,
                message: `No continuation found for action ${actionId}`
            });
            return;
        }

        const resolution = await this.toolRuntime.resolvePendingAction(sessionId, actionId, approved);
        const toolMessage = new ToolMessage({
            tool_call_id: continuation.toolCallId,
            content: resolution.output
        });
        const nextMessages = [...continuation.messages, toolMessage];

        await this.pushTimeline(sessionId, {
            type: 'approval',
            status: approved ? 'success' : 'error',
            turnId: continuation.turnId,
            actionId,
            title: approved ? 'Approval granted' : 'Approval denied',
            detail: resolution.output.slice(0, 500)
        });

        if (approved && resolution.changedFiles.length > 0) {
            this.emit({
                type: 'patch_applied',
                sessionId,
                turnId: continuation.turnId,
                actionId,
                changedFiles: resolution.changedFiles
            });
            await this.pushTimeline(sessionId, {
                type: 'patch',
                status: 'success',
                turnId: continuation.turnId,
                actionId,
                title: 'Patch applied',
                detail: resolution.changedFiles.join(', ')
            });
        }

        this.pendingContinuations.delete(actionId);
        debugLog('Orchestrator', 'Resuming model loop after approval', {
            sessionId: continuation.sessionId,
            turnId: continuation.turnId,
            approved
        });

        await this.runModelLoop({
            sessionId: continuation.sessionId,
            turnId: continuation.turnId,
            mode: continuation.mode,
            model: continuation.model,
            temperature: continuation.temperature,
            messages: nextMessages,
            assistantAccumulated: continuation.assistantAccumulated,
            retries: 0
        });
    }

    private async emitApprovalEvents(sessionId: string, turnId: string, action: PendingApprovalAction): Promise<void> {
        if (action.type === 'patch' && action.patches) {
            this.emit({
                type: 'patch_proposed',
                sessionId,
                turnId,
                actionId: action.id,
                summary: action.summary,
                patches: action.patches
            });
        }
        this.emit({
            type: 'approval_required',
            sessionId,
            turnId,
            actionId: action.id,
            summary: action.summary,
            reason: action.reason
        });
        await this.pushTimeline(sessionId, {
            type: 'approval',
            status: 'needs_approval',
            turnId,
            actionId: action.id,
            title: 'Approval required',
            detail: `${action.summary} (${action.reason})`
        });
    }

    private async emitPlanScaffold(sessionId: string, turnId: string, userText: string): Promise<void> {
        const steps = [
            `Understand requirements: ${userText.slice(0, 90)}`,
            'Inspect relevant files and dependencies',
            'Propose implementation and validation sequence'
        ];
        for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index];
            this.emit({
                type: 'plan_step',
                sessionId,
                turnId,
                text: step,
                step: index + 1
            });
            this.emit({
                type: 'trace_stream',
                sessionId,
                turnId,
                level: 'plan',
                text: `Plan step ${index + 1}: ${step}`
            });
            await this.pushTimeline(sessionId, {
                type: 'plan_step',
                status: 'info',
                turnId,
                title: `Plan step ${index + 1}`,
                detail: step
            });
        }
    }

    private systemPrompt(mode: AssistantMode, model: string): string {
        const basePrompt = [
            'You are Olla Chat Pro, a professional VS Code coding assistant.',
            'Return concise, actionable answers with explicit file paths when relevant.',
            'Do not expose raw chain-of-thought. Summarize reasoning as short status updates.',
            `Current model: ${model}.`
        ];
        if (mode === 'ask') {
            basePrompt.push('Mode ASK: Answer questions and explain code. Do not call write or command tools.');
        } else if (mode === 'plan') {
            basePrompt.push('Mode PLAN: Produce step-by-step implementation plans with risks and validation criteria.');
        } else {
            basePrompt.push('Mode AGENT: Use tools when needed, but favor small, safe, reviewable actions.');
            basePrompt.push('When editing files, call propose_patch with precise findText and replaceText.');
            basePrompt.push('When commands are needed, call run_command and include a short summary.');
        }
        return basePrompt.join(' ');
    }

    private captureSelectionSnapshot(sessionId: string, turnId: string, allowCursorInsert: boolean): SelectionSnapshot | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            debugLog('Orchestrator', 'No active selection for turn', { sessionId, turnId });
            return undefined;
        }
        const start = editor.selection.start;
        const end = editor.selection.end;
        const selectedText = editor.document.getText(editor.selection);
        if (editor.selection.isEmpty && !allowCursorInsert) {
            debugLog('Orchestrator', 'Selection snapshot skipped because selection is empty and cursor insert is disabled', {
                sessionId,
                turnId
            });
            return undefined;
        }
        if (!editor.selection.isEmpty && selectedText.length === 0) {
            debugLog('Orchestrator', 'Selection snapshot skipped due to empty text', { sessionId, turnId });
            return undefined;
        }
        const startOffset = editor.document.offsetAt(start);
        const rangeLabel = `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`;
        return {
            sessionId,
            turnId,
            uri: editor.document.uri.fsPath,
            filePath: this.workspaceRelative(editor.document.uri.fsPath),
            languageId: editor.document.languageId || 'plaintext',
            start,
            end,
            startOffset,
            selectedText,
            rangeLabel
        };
    }

    private selectionKey(sessionId: string, turnId: string): string {
        return `${sessionId}:${turnId}`;
    }

    private shouldTreatAsSelectionEditRequest(text: string): boolean {
        const normalized = text.trim().toLowerCase();
        if (!normalized) {
            return false;
        }
        const editKeywords = /(elobrat|elaborat|expand|rewrite|rephrase|paraphrase|improv|refin|polish|fix|correct|summariz|simplif|shorten|lengthen|clarif|humaniz|create|add|write|implement|generate|build|scaffold|function|class|module|api)/;
        if (editKeywords.test(normalized)) {
            return true;
        }
        return /(this text|this section|selected text|selection|in this file|here|in current file)/.test(normalized);
    }

    private clearPendingSelectionRequestsForSession(sessionId: string): void {
        for (const [key, snapshot] of this.selectionSnapshots.entries()) {
            if (snapshot.sessionId === sessionId) {
                this.selectionSnapshots.delete(key);
            }
        }
        for (const [key, pending] of this.pendingSelectionReplace.entries()) {
            if (pending.sessionId === sessionId) {
                this.pendingSelectionReplace.delete(key);
            }
        }
        for (const key of this.selectionReplaceIntent.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.selectionReplaceIntent.delete(key);
            }
        }
    }

    private clearSelectionStateForSession(sessionId: string): void {
        for (const [key, snapshot] of this.selectionSnapshots.entries()) {
            if (snapshot.sessionId === sessionId) {
                this.selectionSnapshots.delete(key);
            }
        }
        for (const [key, pending] of this.pendingSelectionReplace.entries()) {
            if (pending.sessionId === sessionId) {
                this.pendingSelectionReplace.delete(key);
            }
        }
        for (const key of this.selectionReplaceIntent.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.selectionReplaceIntent.delete(key);
            }
        }
        for (const [key, undoState] of this.selectionUndoState.entries()) {
            if (undoState.sessionId === sessionId) {
                this.selectionUndoState.delete(key);
            }
        }
    }

    private resolveSelectionRange(document: vscode.TextDocument, snapshot: SelectionSnapshot): vscode.Range | undefined {
        const primary = new vscode.Range(snapshot.start, snapshot.end);
        if (document.getText(primary) === snapshot.selectedText) {
            return primary;
        }
        const closestOffset = this.findClosestMatchOffset(
            document.getText(),
            snapshot.selectedText,
            snapshot.startOffset
        );
        if (closestOffset === -1) {
            return undefined;
        }
        const start = document.positionAt(closestOffset);
        const end = document.positionAt(closestOffset + snapshot.selectedText.length);
        return new vscode.Range(start, end);
    }

    private resolveUndoRange(document: vscode.TextDocument, state: SelectionUndoState): vscode.Range | undefined {
        if (state.afterText.length === 0) {
            return undefined;
        }
        const content = document.getText();
        const docLength = content.length;
        const startOffset = Math.max(0, Math.min(state.anchorOffset, docLength));
        const endOffset = Math.max(startOffset, Math.min(startOffset + state.afterText.length, docLength));
        const direct = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
        if (document.getText(direct) === state.afterText) {
            return direct;
        }

        const closestOffset = this.findClosestMatchOffset(content, state.afterText, state.anchorOffset);
        if (closestOffset === -1) {
            return undefined;
        }
        const start = document.positionAt(closestOffset);
        const end = document.positionAt(closestOffset + state.afterText.length);
        return new vscode.Range(start, end);
    }

    private findClosestMatchOffset(content: string, needle: string, preferredOffset: number): number {
        if (needle.length === 0) {
            return -1;
        }
        let hit = content.indexOf(needle);
        if (hit === -1) {
            return -1;
        }
        let best = hit;
        let bestDistance = Math.abs(hit - preferredOffset);
        while (hit !== -1) {
            const distance = Math.abs(hit - preferredOffset);
            if (distance < bestDistance) {
                best = hit;
                bestDistance = distance;
            }
            hit = content.indexOf(needle, hit + 1);
        }
        return best;
    }

    private normalizeReplacementForEditor(text: string, snapshot: SelectionSnapshot): string {
        const trimmed = text.trim();
        if (!trimmed) {
            return '';
        }
        // Prefer pure payload from code fences for code files or cursor inserts.
        const fenced = this.extractFirstCodeFence(trimmed);
        if (fenced && (snapshot.selectedText.length === 0 || this.isCodeLanguage(snapshot.languageId))) {
            return fenced;
        }
        return trimmed;
    }

    private isLikelyEditorReplacement(text: string, snapshot: SelectionSnapshot): boolean {
        if (text.trim().length === 0) {
            return false;
        }
        if (!this.isCodeLanguage(snapshot.languageId)) {
            return true;
        }
        return this.isCodeLikeForLanguage(text, snapshot.languageId);
    }

    private isCodeLikeForLanguage(text: string, languageId: string): boolean {
        const trimmed = text.trim();
        if (trimmed.length < 4) {
            return false;
        }
        const lowered = trimmed.toLowerCase();
        if (/^(sure|here|let me|i can|i will|to do this|first,|analysis:|thinking:)/.test(lowered)) {
            return false;
        }
        const genericCodeSignal = /[{}();=]|=>|\b(function|const|let|var|class|import|export|return|if|for|while|async|await)\b/i;
        if (genericCodeSignal.test(trimmed)) {
            return true;
        }
        if (languageId === 'python') {
            return /\bdef\b|\bclass\b|:\s*$|\breturn\b/.test(trimmed);
        }
        if (languageId === 'json') {
            return /^[\[{]/.test(trimmed) || /":\s*/.test(trimmed);
        }
        if (languageId === 'sql') {
            return /\b(select|insert|update|delete|create|drop)\b/i.test(trimmed);
        }
        return trimmed.split(/\r?\n/).length >= 2 && /[A-Za-z_][\w$]*\s*\(/.test(trimmed);
    }

    private isCodeLanguage(languageId: string): boolean {
        const nonCode = new Set(['plaintext', 'markdown', 'mdx', 'text', 'log']);
        return !nonCode.has(languageId.toLowerCase());
    }

    private normalizeTextForDocumentEol(text: string, document: vscode.TextDocument): string {
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        return text.replace(/\r?\n/g, eol);
    }

    private extractFirstCodeFence(text: string): string | undefined {
        const match = text.match(/```[\w-]*\n([\s\S]*?)```/);
        if (!match || match.length < 2) {
            return undefined;
        }
        return match[1].trim();
    }

    private workspaceRelative(filePath: string): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return filePath;
        }
        return path.relative(workspaceRoot, filePath) || filePath;
    }

    private async ensureSession(maybeSessionId?: string): Promise<SessionRecord | undefined> {
        if (maybeSessionId) {
            const existing = await this.sessionStore.getSession(maybeSessionId);
            if (existing) {
                return existing;
            }
        }
        if (this.activeSessionId) {
            const active = await this.sessionStore.getSession(this.activeSessionId);
            if (active) {
                return active;
            }
        }
        const model = await this.resolveAvailableModel(this.modelService.getConfiguredModel());
        const created = await this.sessionStore.createSession(model, this.defaultMode());
        this.activeSessionId = created.id;
        await this.sessionStore.setActiveSessionId(created.id);
        return created;
    }

    private defaultMode(): AssistantMode {
        const configured = vscode.workspace.getConfiguration('olla-chat').get<string>('defaultMode', 'ask');
        if (configured === 'plan' || configured === 'agent' || configured === 'ask') {
            return configured;
        }
        return 'ask';
    }

    private extractContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            const parts = content
                .map((entry) => {
                    if (typeof entry === 'string') {
                        return entry;
                    }
                    const text = (entry as { text?: unknown }).text;
                    return typeof text === 'string' ? text : '';
                })
                .filter((entry) => entry.length > 0);
            return parts.join('');
        }
        return '';
    }

    private stripThinkBlocks(text: string): string {
        return text
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/<\/?think>/g, '')
            .trim();
    }

    private toAttachment(filePath: string): AttachmentMeta {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
        const isImage = imageExts.has(ext);
        const snippet = isImage ? '[Image attachment]' : this.readSnippet(filePath);
        const imageBase64 = isImage ? this.readImageAsBase64(filePath) : undefined;
        return {
            id: createId('att'),
            name: path.basename(filePath),
            path: filePath,
            kind: isImage ? 'image' : 'file',
            mimeType: isImage ? `image/${ext.replace('.', '')}` : 'text/plain',
            snippet,
            imageBase64
        };
    }

    private readSnippet(filePath: string): string {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > 250_000) {
                return '[Attachment is large; truncated.]';
            }
            return fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return `Unable to read attachment: ${message}`;
        }
    }

    private async pushTimeline(
        sessionId: string,
        event: Omit<SessionRecord['timeline'][number], 'id' | 'createdAt'>
    ): Promise<void> {
        const nextSession = await this.sessionStore.appendTimeline(sessionId, event);
        if (nextSession) {
            this.emit({
                type: 'session_updated',
                session: nextSession,
                activeSessionId: this.activeSessionId
            });
        }
    }

    private async failTurn(sessionId: string, turnId: string, message: string): Promise<void> {
        debugLog('Orchestrator', 'Failing turn', { sessionId, turnId, message });
        const key = this.selectionKey(sessionId, turnId);
        this.selectionSnapshots.delete(key);
        this.pendingSelectionReplace.delete(key);
        this.selectionReplaceIntent.delete(key);
        this.selectionUndoState.delete(key);
        await this.sessionStore.closeRunningTimelineForTurn(sessionId, turnId, 'error');
        let nextSession = await this.sessionStore.appendMessage(sessionId, {
            role: 'assistant',
            content: `**Error:** ${message}`
        });
        if (!nextSession) {
            this.emit({ type: 'error', sessionId, turnId, message });
            return;
        }
        nextSession = await this.sessionStore.appendTimeline(sessionId, {
            type: 'error',
            status: 'error',
            turnId,
            title: 'Turn failed',
            detail: message
        }) ?? nextSession;
        this.emit({
            type: 'session_updated',
            session: nextSession,
            activeSessionId: this.activeSessionId
        });
        this.emit({ type: 'error', sessionId, turnId, message });
        this.emit({ type: 'turn_completed', sessionId, turnId });
    }

    private async upsertTurnPhase(
        sessionId: string,
        turnId: string,
        phaseKey: string,
        event: {
            type: SessionRecord['timeline'][number]['type'];
            status: SessionRecord['timeline'][number]['status'];
            title: string;
            detail?: string;
        }
    ): Promise<void> {
        const nextSession = await this.sessionStore.upsertTimelinePhase(sessionId, turnId, phaseKey, event);
        if (nextSession) {
            this.emit({
                type: 'session_updated',
                session: nextSession,
                activeSessionId: this.activeSessionId
            });
            this.emit({
                type: 'trace_stream',
                sessionId,
                turnId,
                level: 'thinking',
                text: `${event.title}: ${event.detail ?? event.status}`
            });
        }
    }

    private isModelNotFoundError(message: string): boolean {
        return /model\s+'.+?'\s+not found/i.test(message) || /model .* not found/i.test(message);
    }

    private async resolveAvailableModel(preferredModel: string, modelsArg?: ModelCapability[]): Promise<string> {
        const models = modelsArg ?? await this.modelService.listModels();
        const names = new Set(models.map((model) => model.name));
        if (names.size === 0) {
            return preferredModel;
        }
        if (names.has(preferredModel)) {
            return preferredModel;
        }
        const configured = this.modelService.getConfiguredModel();
        if (names.has(configured)) {
            return configured;
        }
        const fallback = models[0].name;
        if (configured !== fallback) {
            await this.modelService.setConfiguredModel(fallback);
        }
        debugLog('Orchestrator', 'Resolved model fallback', {
            preferredModel,
            configuredModel: configured,
            fallback
        });
        return fallback;
    }

    private readImageAsBase64(filePath: string): string | undefined {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > 5 * 1024 * 1024) {
                return undefined;
            }
            return fs.readFileSync(filePath).toString('base64');
        } catch {
            return undefined;
        }
    }

    private defaultContextPolicy(): ContextPolicy {
        const configured = vscode.workspace.getConfiguration('olla-chat').get<string>('contextPolicy', 'auto_light');
        if (configured === 'manual_only' || configured === 'always_project' || configured === 'auto_light') {
            return configured;
        }
        return 'auto_light';
    }

    private defaultContextScope(): ContextScope {
        return {
            useSelection: true,
            useActiveFile: true,
            useOpenFiles: false,
            useProjectMap: false
        };
    }

    private clampTemperature(value: number): number {
        return Math.max(0, Math.min(2, Math.round(value * 10) / 10));
    }
}

function dedupeAttachments(attachments: AttachmentMeta[]): AttachmentMeta[] {
    const seen = new Set<string>();
    const deduped: AttachmentMeta[] = [];
    for (const attachment of attachments) {
        const key = `${attachment.path}:${attachment.kind}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(attachment);
    }
    return deduped;
}
