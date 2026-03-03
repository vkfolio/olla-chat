export type AssistantMode = 'ask' | 'plan' | 'agent';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
    id: string;
    role: ChatRole;
    content: string;
    createdAt: number;
}

export type TimelineType =
    | 'thinking'
    | 'plan_step'
    | 'tool'
    | 'subagent'
    | 'approval'
    | 'patch'
    | 'system'
    | 'error';

export type TimelineStatus = 'info' | 'running' | 'success' | 'error' | 'needs_approval';

export interface TimelineEvent {
    id: string;
    turnId?: string;
    phaseKey?: string;
    actionId?: string;
    type: TimelineType;
    status: TimelineStatus;
    title: string;
    detail?: string;
    createdAt: number;
    closedAt?: number;
    meta?: Record<string, unknown>;
}

export interface AttachmentMeta {
    id: string;
    name: string;
    path: string;
    kind: 'file' | 'image';
    mimeType?: string;
    snippet?: string;
}

export interface ProposedPatch {
    path: string;
    summary: string;
    before: string;
    after: string;
    diff: string;
}

export interface SessionRecord {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: AssistantMode;
    model: string;
    messages: ChatMessage[];
    timeline: TimelineEvent[];
    attachments: AttachmentMeta[];
}

export interface ModelCapability {
    name: string;
    toolCalling: boolean;
    vision: boolean;
}

export type ClientRequest =
    | { type: 'bootstrap' }
    | { type: 'send_turn'; sessionId?: string; mode: AssistantMode; model?: string; text: string }
    | { type: 'set_model'; model: string }
    | { type: 'refresh_models' }
    | { type: 'attach_picker'; sessionId: string }
    | { type: 'detach_attachment'; sessionId: string; attachmentId: string }
    | { type: 'approve_action'; sessionId: string; actionId: string; approved: boolean }
    | { type: 'session_create'; mode?: AssistantMode }
    | { type: 'session_switch'; sessionId: string }
    | { type: 'session_rename'; sessionId: string; title: string }
    | { type: 'session_delete'; sessionId: string }
    | { type: 'open_settings' };

export type ServerEvent =
    | {
        type: 'bootstrap';
        sessions: SessionRecord[];
        activeSessionId: string;
        models: ModelCapability[];
        currentModel: string;
    }
    | { type: 'session_updated'; session: SessionRecord; activeSessionId: string }
    | { type: 'session_deleted'; sessionId: string; activeSessionId: string }
    | { type: 'models_updated'; models: ModelCapability[]; currentModel: string }
    | { type: 'turn_started'; sessionId: string; turnId: string; mode: AssistantMode }
    | { type: 'token_stream'; sessionId: string; turnId: string; delta: string }
    | { type: 'thinking_summary'; sessionId: string; turnId: string; text: string }
    | { type: 'plan_step'; sessionId: string; turnId: string; text: string; step: number }
    | { type: 'tool_event'; sessionId: string; turnId: string; toolName: string; status: 'start' | 'output' | 'end'; text?: string }
    | { type: 'subagent_event'; sessionId: string; turnId: string; status: 'start' | 'end'; text: string }
    | { type: 'patch_proposed'; sessionId: string; turnId: string; actionId: string; summary: string; patches: ProposedPatch[] }
    | { type: 'approval_required'; sessionId: string; turnId: string; actionId: string; summary: string; reason: string }
    | { type: 'patch_applied'; sessionId: string; turnId: string; actionId: string; changedFiles: string[] }
    | { type: 'turn_completed'; sessionId: string; turnId: string }
    | { type: 'error'; sessionId?: string; turnId?: string; message: string };
