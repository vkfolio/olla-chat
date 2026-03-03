import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
    AssistantMode,
    AttachmentMeta,
    ClientRequest,
    ModelCapability,
    ServerEvent,
    SessionRecord
} from '../types/protocol';
import { ContextEngine } from './ContextEngine';
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
    messages: BaseMessage[];
    assistantAccumulated: string;
    toolCallId: string;
}

type EmitFn = (event: ServerEvent) => void;

export class ConversationOrchestrator {
    private readonly sessionStore: SessionStore;
    private readonly modelService: ModelService;
    private readonly contextEngine: ContextEngine;
    private readonly toolRuntime: ToolRuntime;
    private readonly pendingContinuations = new Map<string, PendingContinuation>();
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
        if (sessions.length === 0) {
            const created = await this.sessionStore.createSession(model, this.defaultMode());
            this.activeSessionId = created.id;
            return;
        }
        const active = await this.sessionStore.getActiveSessionId();
        this.activeSessionId = active && sessions.some((session) => session.id === active)
            ? active
            : sessions[0].id;
        await this.sessionStore.setActiveSessionId(this.activeSessionId);
    }

    public async handleClientRequest(request: ClientRequest): Promise<void> {
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

        const mode = request.mode ?? session.mode;
        const requestedModel = request.model ?? session.model ?? this.modelService.getConfiguredModel();
        const models = await this.modelService.listModels();
        const model = await this.resolveAvailableModel(requestedModel, models);
        const turnId = createId('turn');

        let nextSession = await this.sessionStore.setSessionModeAndModel(session.id, mode, model);
        if (!nextSession) {
            nextSession = session;
        }

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

        if (mode === 'plan') {
            await this.emitPlanScaffold(nextSession.id, turnId, request.text);
        }

        await this.upsertTurnPhase(nextSession.id, turnId, 'analyzing_request', {
            type: 'thinking',
            status: 'running',
            title: 'Analyzing request',
            detail: `Mode: ${mode}. Preparing project-aware context.`
        });

        try {
            const context = await this.contextEngine.buildContext(request.text, mode, nextSession.attachments);
            await this.upsertTurnPhase(nextSession.id, turnId, 'analyzing_request', {
                type: 'thinking',
                status: 'success',
                title: 'Analyzing request',
                detail: `Prepared project-aware context with ${context.citations.length} source reference(s).`
            });

            const history = nextSession.messages.slice(-16);
            const messages: BaseMessage[] = [
                new SystemMessage(this.systemPrompt(mode, model)),
                ...history.map((message) => (
                    message.role === 'assistant'
                        ? new AIMessage(message.content)
                        : new HumanMessage(message.content)
                )),
                new HumanMessage(
                    `${request.text}\n\n` +
                    `Use this context bundle when relevant:\n${context.text}\n\n` +
                    `Citations:\n- ${context.citations.join('\n- ')}`
                )
            ];

            await this.runModelLoop({
                sessionId: nextSession.id,
                turnId,
                mode,
                model,
                messages,
                assistantAccumulated: '',
                retries: 0
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
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
        messages: BaseMessage[];
        assistantAccumulated: string;
        retries: number;
    }): Promise<void> {
        try {
            const capabilities = this.modelService.withCapabilities(state.model);
            const allowTools = state.mode !== 'ask' && capabilities.toolCalling;
            const toolSchemas = this.toolRuntime.getToolSchemas(state.mode);

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

            let chatModel: unknown = this.modelService.createChatModel(state.model);
            if (allowTools && toolSchemas.length > 0) {
                chatModel = (chatModel as { bindTools: (schemas: unknown[]) => unknown }).bindTools(toolSchemas);
            }

            const stream = await (chatModel as { stream: (messages: BaseMessage[]) => Promise<AsyncIterable<unknown>> }).stream(state.messages);
            let fullResponse = '';
            const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
            let insideThink = false;

            for await (const rawChunk of stream) {
                const chunk = rawChunk as { content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }> };
                const delta = this.extractContent(chunk.content);
                if (delta.length > 0) {
                    let output = delta;
                    if (output.includes('<think>')) {
                        insideThink = true;
                        output = output.substring(0, output.indexOf('<think>'));
                        this.emit({ type: 'thinking_summary', sessionId: state.sessionId, turnId: state.turnId, text: 'Model is reasoning about next actions.' });
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

            const cleanedResponse = this.stripThinkBlocks(fullResponse).trim();
            const accumulated = [state.assistantAccumulated, cleanedResponse].filter((entry) => entry.length > 0).join('\n');
            const aiMessage = new AIMessage({
                content: cleanedResponse,
                tool_calls: toolCalls
            } as any);
            const nextMessages = [...state.messages, aiMessage];

            if (toolCalls.length === 0 || !allowTools) {
                await this.finishTurn(state.sessionId, state.turnId, accumulated);
                return;
            }

            this.emit({
                type: 'subagent_event',
                sessionId: state.sessionId,
                turnId: state.turnId,
                status: 'start',
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
                this.emit({
                    type: 'tool_event',
                    sessionId: state.sessionId,
                    turnId: state.turnId,
                    toolName: toolCall.name,
                    status: 'start'
                });
                const execution = await this.toolRuntime.executeToolCall(
                    state.sessionId,
                    toolCall.id,
                    toolCall.name,
                    toolCall.args
                );

                if (execution.kind === 'completed') {
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
                    messages: workingMessages,
                    assistantAccumulated: accumulated,
                    toolCallId: execution.action.toolCallId
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

            await this.runModelLoop({
                ...state,
                messages: workingMessages,
                assistantAccumulated: accumulated,
                retries: state.retries
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
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

    private async finishTurn(sessionId: string, turnId: string, assistantContent: string): Promise<void> {
        await this.sessionStore.closeRunningTimelineForTurn(sessionId, turnId, 'success');
        let nextSession = await this.sessionStore.appendMessage(sessionId, {
            role: 'assistant',
            content: assistantContent.length > 0 ? assistantContent : 'Done.'
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
        this.emit({ type: 'turn_completed', sessionId, turnId });
    }

    private async handleApproval(sessionId: string, actionId: string, approved: boolean): Promise<void> {
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

        await this.runModelLoop({
            sessionId: continuation.sessionId,
            turnId: continuation.turnId,
            mode: continuation.mode,
            model: continuation.model,
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
        return {
            id: createId('att'),
            name: path.basename(filePath),
            path: filePath,
            kind: isImage ? 'image' : 'file',
            mimeType: isImage ? `image/${ext.replace('.', '')}` : 'text/plain',
            snippet
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
        return fallback;
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
