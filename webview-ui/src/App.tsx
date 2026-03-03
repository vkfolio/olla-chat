import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  FileUp,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import './App.css';

// @ts-expect-error VS Code injects this in webviews
const vscode = acquireVsCodeApi();

type AssistantMode = 'ask' | 'plan' | 'agent';
type ChatRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

interface TimelineEvent {
  id: string;
  turnId?: string;
  phaseKey?: string;
  actionId?: string;
  type: 'thinking' | 'plan_step' | 'tool' | 'subagent' | 'approval' | 'patch' | 'system' | 'error';
  status: 'info' | 'running' | 'success' | 'error' | 'needs_approval';
  title: string;
  detail?: string;
  createdAt: number;
  closedAt?: number;
}

interface AttachmentMeta {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'image';
}

interface SessionRecord {
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

interface ModelCapability {
  name: string;
  toolCalling: boolean;
  vision: boolean;
}

interface PendingApproval {
  sessionId: string;
  turnId: string;
  actionId: string;
  summary: string;
  reason: string;
}

interface PatchProposal {
  sessionId: string;
  turnId: string;
  actionId: string;
  summary: string;
  patches: Array<{
    path: string;
    summary: string;
    diff: string;
  }>;
}

const SUGGESTED_ACTIONS = ['Build Workspace', 'Show Config', 'Review Open Files'];

interface SessionPreview {
  session: SessionRecord;
  subtitle: string;
  timeLabel: string;
  failed: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function summarizeSession(session: SessionRecord): SessionPreview {
  const timeline = session.timeline;
  const lastEvent = timeline.length > 0 ? timeline[timeline.length - 1] : undefined;
  const failed = lastEvent?.status === 'error' || lastEvent?.type === 'error';

  let subtitle = 'No activity yet.';
  if (lastEvent?.title === 'Turn complete') {
    const turnId = lastEvent.turnId;
    const turnEvents = timeline.filter((event) => event.turnId === turnId);
    const startedAt = turnEvents.length > 0 ? Math.min(...turnEvents.map((event) => event.createdAt)) : session.updatedAt;
    const durationSec = Math.max(1, Math.round((lastEvent.createdAt - startedAt) / 1000));
    subtitle = `Completed in ${durationSec}s.`;
  } else if (failed) {
    subtitle = 'Failed.';
  } else if (lastEvent?.status === 'running') {
    subtitle = 'In progress...';
  } else if (lastEvent?.title) {
    subtitle = `${lastEvent.title}.`;
  }

  return {
    session,
    subtitle,
    timeLabel: formatRelativeTime(session.updatedAt),
    failed
  };
}

function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [mode, setMode] = useState<AssistantMode>('ask');
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [currentModel, setCurrentModel] = useState('llama3');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamTargetText, setStreamTargetText] = useState<Record<string, string>>({});
  const [streamDisplayText, setStreamDisplayText] = useState<Record<string, string>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [patchProposals, setPatchProposals] = useState<Record<string, PatchProposal>>({});
  const [openMenu, setOpenMenu] = useState<null | 'mode' | 'model'>(null);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [showSessionsFeed, setShowSessionsFeed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId]
  );

  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const timeline = useMemo(() => activeSession?.timeline ?? [], [activeSession]);
  const attachments = useMemo(() => activeSession?.attachments ?? [], [activeSession]);
  const sessionPreviews = useMemo(() => sessions.map(summarizeSession), [sessions]);

  const normalizedTimeline = useMemo(() => {
    const terminalTurns = new Set<string>();
    for (const event of timeline) {
      if (!event.turnId) continue;
      if (event.title === 'Turn complete' || event.type === 'error' || event.status === 'error') {
        terminalTurns.add(event.turnId);
      }
    }
    return timeline
      .slice(-80)
      .map((event) => {
        if (event.status === 'running' && event.turnId && terminalTurns.has(event.turnId)) {
          return { ...event, status: 'success' as const };
        }
        return event;
      });
  }, [timeline]);

  const approvalsForActiveSession = useMemo(
    () => Object.values(pendingApprovals).filter((entry) => entry.sessionId === activeSessionId),
    [pendingApprovals, activeSessionId]
  );

  const streamForSession = streamDisplayText[activeSessionId] || '';
  const shouldShowSessions = showSessionsFeed || (!isStreaming && messages.length === 0);
  const hasConversation = messages.length > 0 || normalizedTimeline.length > 0 || isStreaming;

  useEffect(() => {
    vscode.postMessage({ type: 'bootstrap' });
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'bootstrap': {
          const nextSessions = message.sessions || [];
          const nextActiveId = message.activeSessionId || '';
          const active = nextSessions.find((session: SessionRecord) => session.id === nextActiveId);
          setSessions(nextSessions);
          setActiveSessionId(nextActiveId);
          setModels(message.models || []);
          setCurrentModel(message.currentModel || active?.model || 'llama3');
          setMode(active?.mode || 'ask');
          setShowSessionsFeed(!active || active.messages.length === 0);
          break;
        }
        case 'session_updated':
          setSessions((prev) => {
            const index = prev.findIndex((session) => session.id === message.session.id);
            if (index === -1) return [message.session, ...prev];
            const next = [...prev];
            next[index] = message.session;
            return next.sort((a, b) => b.updatedAt - a.updatedAt);
          });
          setActiveSessionId(message.activeSessionId);
          if (message.session.id === message.activeSessionId) {
            setMode(message.session.mode);
            setCurrentModel((prev) => message.session.model || prev);
          }
          break;
        case 'session_deleted':
          setSessions((prev) => prev.filter((session) => session.id !== message.sessionId));
          setActiveSessionId(message.activeSessionId || '');
          break;
        case 'models_updated':
          setModels(message.models || []);
          setCurrentModel((prev) => message.currentModel || prev);
          break;
        case 'turn_started':
          setIsStreaming(true);
          setShowSessionsFeed(false);
          setStreamTargetText((prev) => ({ ...prev, [message.sessionId]: '' }));
          setStreamDisplayText((prev) => ({ ...prev, [message.sessionId]: '' }));
          break;
        case 'token_stream':
          setStreamTargetText((prev) => ({
            ...prev,
            [message.sessionId]: `${prev[message.sessionId] || ''}${message.delta || ''}`
          }));
          break;
        case 'approval_required':
          setIsStreaming(false);
          setPendingApprovals((prev) => ({
            ...prev,
            [message.actionId]: {
              sessionId: message.sessionId,
              turnId: message.turnId,
              actionId: message.actionId,
              summary: message.summary,
              reason: message.reason
            }
          }));
          break;
        case 'patch_proposed':
          setPatchProposals((prev) => ({
            ...prev,
            [message.actionId]: {
              sessionId: message.sessionId,
              turnId: message.turnId,
              actionId: message.actionId,
              summary: message.summary,
              patches: message.patches || []
            }
          }));
          break;
        case 'patch_applied':
          setPendingApprovals((prev) => {
            const next = { ...prev };
            delete next[message.actionId];
            return next;
          });
          setPatchProposals((prev) => {
            const next = { ...prev };
            delete next[message.actionId];
            return next;
          });
          break;
        case 'turn_completed':
          setIsStreaming(false);
          setStreamTargetText((prev) => ({ ...prev, [message.sessionId]: '' }));
          setStreamDisplayText((prev) => ({ ...prev, [message.sessionId]: '' }));
          break;
        case 'error':
          setIsStreaming(false);
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, normalizedTimeline, streamForSession, approvalsForActiveSession, isStreaming, shouldShowSessions]);

  useEffect(() => {
    const handleClickAway = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.menu-root')) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    const target = streamTargetText[activeSessionId] || '';
    const shown = streamDisplayText[activeSessionId] || '';
    if (shown.length >= target.length) return;

    const remaining = target.length - shown.length;
    const step = Math.max(1, Math.min(remaining, Math.ceil(target.length / 150)));
    const timer = window.setTimeout(() => {
      setStreamDisplayText((prev) => ({
        ...prev,
        [activeSessionId]: target.slice(0, shown.length + step)
      }));
    }, 10);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, streamTargetText, streamDisplayText]);

  const sendTurn = () => {
    if (!activeSessionId || !input.trim() || isStreaming) return;
    vscode.postMessage({
      type: 'send_turn',
      sessionId: activeSessionId,
      mode,
      model: currentModel,
      text: input.trim()
    });
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
    }
  };

  const askSuggested = (prompt: string) => {
    if (!activeSessionId || isStreaming) return;
    setShowSessionsFeed(false);
    vscode.postMessage({
      type: 'send_turn',
      sessionId: activeSessionId,
      mode: 'agent',
      model: currentModel,
      text: prompt
    });
  };

  const approveAction = (actionId: string, approved: boolean) => {
    if (!activeSessionId) return;
    vscode.postMessage({
      type: 'approve_action',
      sessionId: activeSessionId,
      actionId,
      approved
    });
    if (!approved) {
      setPendingApprovals((prev) => {
        const next = { ...prev };
        delete next[actionId];
        return next;
      });
    }
  };

  const onSwitchSession = (sessionId: string) => {
    setShowSessionsFeed(false);
    vscode.postMessage({ type: 'session_switch', sessionId });
  };

  const onCreateSession = () => {
    setShowSessionsFeed(false);
    vscode.postMessage({ type: 'session_create', mode });
  };

  const onDeleteSession = () => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'session_delete', sessionId: activeSessionId });
  };

  const onAttachContext = () => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'attach_picker', sessionId: activeSessionId });
  };

  const onDetachAttachment = (attachmentId: string) => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'detach_attachment', sessionId: activeSessionId, attachmentId });
  };

  const setModel = (modelName: string) => {
    setCurrentModel(modelName);
    vscode.postMessage({ type: 'set_model', model: modelName });
    setOpenMenu(null);
  };

  const renderEventIcon = (event: TimelineEvent) => {
    if (event.type === 'tool') return <Search size={12} />;
    if (event.type === 'plan_step') return <Check size={12} />;
    if (event.type === 'subagent') return <ChevronRight size={12} />;
    if (event.type === 'patch') return <FolderOpen size={12} />;
    if (event.type === 'approval') return <MessageSquare size={12} />;
    if (event.status === 'running') return <Loader2 size={12} className="spin" />;
    return <ChevronRight size={12} />;
  };

  const activeTitle = (activeSession?.title || 'New Chat').toUpperCase();
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);

  return (
    <div className="shell">
      <header className="top-toolbar">
        <div className="toolbar-title">CHAT</div>
        <div className="toolbar-actions">
          <button className="chrome-btn" onClick={() => setShowSessionsFeed((prev) => !prev)} title="Toggle sessions">
            <Clock3 size={14} />
          </button>
          <button className="chrome-btn" onClick={onCreateSession} title="New chat">
            <Plus size={14} />
          </button>
          <button className="chrome-btn" onClick={() => vscode.postMessage({ type: 'open_settings' })} title="Settings">
            <Settings size={14} />
          </button>
          <button className="chrome-btn" onClick={onDeleteSession} title="Delete session">
            <Trash2 size={14} />
          </button>
        </div>
      </header>

      <div className="session-header">
        <span className="active-title">{activeTitle}</span>
      </div>

      <main className="conversation" ref={scrollRef}>
        {shouldShowSessions && (
          <section className="sessions-feed">
            <div className="sessions-head">SESSIONS</div>
            {sessionPreviews.slice(0, 14).map((preview) => (
              <button
                key={preview.session.id}
                className={`session-row ${preview.session.id === activeSessionId ? 'active' : ''}`}
                onClick={() => onSwitchSession(preview.session.id)}
              >
                <div className="session-dot" />
                <div className="session-body">
                  <div className="session-name">{preview.session.title}</div>
                  <div className={`session-sub ${preview.failed ? 'failed' : ''}`}>{preview.subtitle}</div>
                </div>
                <div className="session-time">{preview.timeLabel}</div>
              </button>
            ))}
            {sessionPreviews.length > 14 && (
              <div className="more-row">MORE ({sessionPreviews.length - 14})</div>
            )}
          </section>
        )}

        {!shouldShowSessions && !hasConversation && (
          <div className="empty-state">
            <Sparkles size={34} />
            <h2>Build with Agent</h2>
            <p>AI responses may be inaccurate.</p>
            <button className="text-link" onClick={() => askSuggested('Generate agent instructions for this codebase')}>
              Generate Agent Instructions
            </button>
            <div className="suggested">
              <div className="suggested-title">SUGGESTED ACTIONS</div>
              <div className="suggested-row">
                {SUGGESTED_ACTIONS.map((label) => (
                  <button key={label} className="chip" onClick={() => askSuggested(label)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {!shouldShowSessions && messages.map((message) => (
          <div key={message.id} className={`msg ${message.role}`}>
            {message.role === 'user' ? (
              <div className="user-bubble">{message.content}</div>
            ) : (
              <div className="assistant-content markdown-body">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {!shouldShowSessions && normalizedTimeline.length > 0 && (
          <div className="events-feed">
            {normalizedTimeline.map((event) => (
              <div key={event.id} className={`event-row ${event.status}`}>
                <button
                  className="event-main"
                  onClick={() => {
                    if (!event.detail) return;
                    setExpandedEvents((prev) => ({ ...prev, [event.id]: !prev[event.id] }));
                  }}
                >
                  <span className="event-icon">{renderEventIcon(event)}</span>
                  <span className="event-title">{event.title}</span>
                  {event.detail && (
                    expandedEvents[event.id]
                      ? <ChevronUp size={12} className="event-toggle" />
                      : <ChevronDown size={12} className="event-toggle" />
                  )}
                </button>
                {event.detail && (
                  <div className={`event-detail ${expandedEvents[event.id] ? 'open' : ''}`}>
                    {event.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!shouldShowSessions && isStreaming && streamForSession && (
          <div className="msg assistant">
            <div className="assistant-content markdown-body streaming">
              <ReactMarkdown>{streamForSession}</ReactMarkdown>
              <span className="typing-caret" />
            </div>
          </div>
        )}

        {!shouldShowSessions && approvalsForActiveSession.map((approval) => {
          const proposal = patchProposals[approval.actionId];
          return (
            <div key={approval.actionId} className="approval-card">
              <div className="approval-head">Approval Required</div>
              <div className="approval-summary">{approval.summary}</div>
              <div className="approval-reason">{approval.reason}</div>
              {proposal?.patches?.map((patch, index) => (
                <div key={`${approval.actionId}_${index}`} className="diff-box">
                  <div className="diff-path">{patch.path}</div>
                  <pre>{patch.diff}</pre>
                </div>
              ))}
              <div className="approval-actions">
                <button className="ok" onClick={() => approveAction(approval.actionId, true)}>Approve</button>
                <button className="no" onClick={() => approveAction(approval.actionId, false)}>Reject</button>
              </div>
            </div>
          );
        })}
      </main>

      <footer className="composer">
        <div className="attachments-row">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="attachment-chip">
              <span>{attachment.name}</span>
              <button onClick={() => onDetachAttachment(attachment.id)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        <button className="context-btn" onClick={onAttachContext}>
          <FileUp size={12} />
          Add Context...
        </button>

        <textarea
          ref={textareaRef}
          className="input-box"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = '44px';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendTurn();
            }
          }}
          placeholder={isStreaming ? 'Waiting for response...' : 'Outline the goal or problem to research'}
          rows={1}
          disabled={isStreaming || !activeSessionId}
        />

        <div className="composer-bottom">
          <div className="bottom-left">
            <div className="menu-root">
              <button className="pill-btn" onClick={() => setOpenMenu((prev) => (prev === 'mode' ? null : 'mode'))}>
                {modeLabel}
                <ChevronDown size={12} className={openMenu === 'mode' ? 'chev open' : 'chev'} />
              </button>
              {openMenu === 'mode' && (
                <div className="menu-panel bottom-menu">
                  {(['agent', 'ask', 'plan'] as AssistantMode[]).map((entry) => (
                    <button
                      key={entry}
                      className={`menu-item ${entry === mode ? 'selected' : ''}`}
                      onClick={() => {
                        setMode(entry);
                        setOpenMenu(null);
                      }}
                    >
                      <span>{entry.charAt(0).toUpperCase() + entry.slice(1)}</span>
                      {entry === mode && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="menu-root">
              <button className="pill-btn model-pill" onClick={() => setOpenMenu((prev) => (prev === 'model' ? null : 'model'))}>
                <span>{currentModel}</span>
                <ChevronDown size={12} className={openMenu === 'model' ? 'chev open' : 'chev'} />
              </button>
              {openMenu === 'model' && (
                <div className="menu-panel bottom-menu model-menu">
                  {(models.length > 0 ? models : [{ name: currentModel, toolCalling: true, vision: false }]).map((model) => (
                    <button
                      key={model.name}
                      className={`menu-item ${model.name === currentModel ? 'selected' : ''}`}
                      onClick={() => setModel(model.name)}
                    >
                      <span>{model.name}</span>
                      {model.name === currentModel && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className="mini-btn" onClick={() => vscode.postMessage({ type: 'refresh_models' })} title="Refresh models">
              <RefreshCw size={12} />
            </button>
          </div>
          <button className={`send ${input.trim() ? 'active' : ''}`} onClick={sendTurn} disabled={isStreaming || !activeSessionId}>
            <SendHorizontal size={14} />
          </button>
        </div>
      </footer>
    </div>
  );
}

export default App;
