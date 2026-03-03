import * as vscode from 'vscode';
import { createId } from './id';
import { AssistantMode, ChatMessage, SessionRecord, TimelineEvent, AttachmentMeta } from '../types/protocol';

const SESSIONS_KEY = 'olla-chat.sessions.v2';
const ACTIVE_SESSION_KEY = 'olla-chat.activeSessionId.v2';

export class SessionStore {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public async listSessions(): Promise<SessionRecord[]> {
        const sessions = this.context.workspaceState.get<SessionRecord[]>(SESSIONS_KEY, []);
        return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    public async getSession(sessionId: string): Promise<SessionRecord | undefined> {
        const sessions = await this.listSessions();
        return sessions.find((session) => session.id === sessionId);
    }

    public async createSession(model: string, mode: AssistantMode = 'ask'): Promise<SessionRecord> {
        const now = Date.now();
        const session: SessionRecord = {
            id: createId('session'),
            title: 'New Chat',
            createdAt: now,
            updatedAt: now,
            mode,
            model,
            messages: [],
            timeline: [],
            attachments: []
        };
        const sessions = await this.listSessions();
        sessions.unshift(session);
        await this.context.workspaceState.update(SESSIONS_KEY, sessions);
        await this.setActiveSessionId(session.id);
        return session;
    }

    public async saveSession(nextSession: SessionRecord): Promise<void> {
        const sessions = await this.listSessions();
        const index = sessions.findIndex((session) => session.id === nextSession.id);
        if (index === -1) {
            sessions.unshift(nextSession);
        } else {
            sessions[index] = nextSession;
        }
        await this.context.workspaceState.update(SESSIONS_KEY, sessions);
    }

    public async deleteSession(sessionId: string): Promise<void> {
        const sessions = await this.listSessions();
        const next = sessions.filter((session) => session.id !== sessionId);
        await this.context.workspaceState.update(SESSIONS_KEY, next);
    }

    public async renameSession(sessionId: string, title: string): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }
        const next: SessionRecord = {
            ...session,
            title: title.trim() || session.title,
            updatedAt: Date.now()
        };
        await this.saveSession(next);
        return next;
    }

    public async appendMessage(sessionId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }
        const next: SessionRecord = {
            ...session,
            messages: [
                ...session.messages,
                {
                    id: createId('msg'),
                    createdAt: Date.now(),
                    ...message
                }
            ],
            updatedAt: Date.now()
        };
        await this.saveSession(next);
        return next;
    }

    public async appendTimeline(sessionId: string, event: Omit<TimelineEvent, 'id' | 'createdAt'>): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }
        const nextTimeline = [
            ...session.timeline,
            {
                id: createId('event'),
                createdAt: Date.now(),
                ...event
            }
        ];

        const next: SessionRecord = {
            ...session,
            timeline: nextTimeline.slice(-400),
            updatedAt: Date.now()
        };

        await this.saveSession(next);
        return next;
    }

    public async upsertTimelinePhase(
        sessionId: string,
        turnId: string,
        phaseKey: string,
        event: Omit<TimelineEvent, 'id' | 'createdAt' | 'turnId' | 'phaseKey' | 'closedAt'>
    ): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }

        const timeline = [...session.timeline];
        const existingIndex = [...timeline]
            .reverse()
            .findIndex((item) => item.turnId === turnId && item.phaseKey === phaseKey);
        const now = Date.now();

        if (existingIndex >= 0) {
            const index = timeline.length - 1 - existingIndex;
            const previous = timeline[index];
            timeline[index] = {
                ...previous,
                ...event,
                turnId,
                phaseKey,
                closedAt: event.status === 'running' ? undefined : now
            };
        } else {
            timeline.push({
                id: createId('event'),
                createdAt: now,
                turnId,
                phaseKey,
                ...event,
                closedAt: event.status === 'running' ? undefined : now
            });
        }

        const next: SessionRecord = {
            ...session,
            timeline: timeline.slice(-400),
            updatedAt: now
        };
        await this.saveSession(next);
        return next;
    }

    public async closeRunningTimelineForTurn(
        sessionId: string,
        turnId: string,
        status: 'success' | 'error'
    ): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }

        const now = Date.now();
        let changed = false;
        const timeline = session.timeline.map((event) => {
            if (event.turnId === turnId && event.status === 'running') {
                changed = true;
                return {
                    ...event,
                    status,
                    closedAt: now
                };
            }
            return event;
        });

        if (!changed) {
            return session;
        }

        const next: SessionRecord = {
            ...session,
            timeline,
            updatedAt: now
        };
        await this.saveSession(next);
        return next;
    }

    public async setAttachments(sessionId: string, attachments: AttachmentMeta[]): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }
        const next: SessionRecord = {
            ...session,
            attachments,
            updatedAt: Date.now()
        };
        await this.saveSession(next);
        return next;
    }

    public async setSessionModeAndModel(sessionId: string, mode: AssistantMode, model: string): Promise<SessionRecord | undefined> {
        const session = await this.getSession(sessionId);
        if (!session) {
            return undefined;
        }
        const next: SessionRecord = {
            ...session,
            mode,
            model,
            updatedAt: Date.now()
        };
        await this.saveSession(next);
        return next;
    }

    public async getActiveSessionId(): Promise<string | undefined> {
        return this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
    }

    public async setActiveSessionId(sessionId: string): Promise<void> {
        await this.context.workspaceState.update(ACTIVE_SESSION_KEY, sessionId);
    }
}
