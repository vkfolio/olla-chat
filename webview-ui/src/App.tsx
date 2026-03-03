import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Attachment,
  Bin,
  Check,
  Clock,
  ControlSlider,
  Copy,
  IconoirProvider,
  MessageText,
  NavArrowDown,
  Plus,
  Refresh,
  SendDiagonal,
  Settings,
  Xmark
} from 'iconoir-react';
import './App.css';

// @ts-expect-error VS Code injects this in webviews
const vscode = acquireVsCodeApi();

type AssistantMode = 'ask' | 'plan' | 'agent';
type ContextPolicy = 'auto_light' | 'manual_only' | 'always_project';
type ChatRole = 'user' | 'assistant' | 'system';

interface ContextScope {
  useSelection: boolean;
  useActiveFile: boolean;
  useOpenFiles: boolean;
  useProjectMap: boolean;
}

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
  temperature: number;
  contextPolicy: ContextPolicy;
  contextScope: ContextScope;
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
  patches: Array<{ path: string; summary: string; diff: string }>;
}

interface SelectionContextInfo {
  sessionId: string;
  turnId: string;
  filePath: string;
  range: string;
  chars: number;
}

interface PendingSelectionReplace {
  sessionId: string;
  turnId: string;
  filePath: string;
  range: string;
}

interface SelectionReplaceState {
  sessionId: string;
  turnId: string;
  filePath: string;
  range: string;
  mode: 'agent_auto' | 'ask_manual';
}

interface TransientEvent {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  title: string;
  detail?: string;
  status: 'info' | 'running' | 'success' | 'error';
}

type FeedItem =
  | { kind: 'message'; id: string; createdAt: number; message: ChatMessage }
  | { kind: 'event'; id: string; createdAt: number; event: TimelineEvent | TransientEvent };

const SUGGESTED_ACTIONS = ['Build Workspace', 'Show Config', 'Review Open Files'];

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        code({ className, children, ...props }) {
          const raw = String(children).replace(/\n$/, '');
          const match = /language-([\w-]+)/.exec(className || '');
          const language = (match?.[1] || 'text').toLowerCase();
          if (match || raw.includes('\n')) {
            return <CodeBlock code={raw} language={language} />;
          }
          return (
            <code className={`inline-code ${className || ''}`} {...props}>
              {children}
            </code>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const ok = await copyToClipboard(code);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`code-block lang-${language}`}>
      <div className="code-head">
        <span className="code-lang">{formatLanguageLabel(language)}</span>
        <button className={`code-copy ${copied ? 'copied' : ''}`} onClick={onCopy}>
          {copied ? <Check width={12} height={12} /> : <Copy width={12} height={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{renderHighlightedCode(code, language)}</code>
      </pre>
    </div>
  );
}

interface Token {
  text: string;
  type?: 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'property' | 'boolean' | 'command';
}

function renderHighlightedCode(code: string, language: string): ReactNode {
  const tokens = tokenizeCode(code, language);
  return tokens.map((token, index) => (
    <span key={`${index}_${token.text.length}`} className={token.type ? `tok-${token.type}` : undefined}>
      {token.text}
    </span>
  ));
}

function tokenizeCode(code: string, language: string): Token[] {
  if (isJsLike(language)) {
    const pattern = /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|new|try|catch|throw|async|await|switch|case|break|continue|default|true|false|null|undefined)\b|=>|[{}()[\].,;:+\-*/%=!<>|&^~?]/gm;
    return tokenizeByPattern(code, pattern, (value) => classifyJsToken(value));
  }
  if (language === 'json') {
    const pattern = /"(?:\\.|[^"\\])*"|\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false|null)\b|[{}[\],:]/gim;
    return tokenizeByPattern(code, pattern, (value, source, index) => classifyJsonToken(value, source, index));
  }
  if (language === 'python') {
    const pattern = /#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|lambda|async|await|True|False|None)\b|[(){}[\].,:+\-*/%=<>!]/gm;
    return tokenizeByPattern(code, pattern, (value) => classifyPythonToken(value));
  }
  if (language === 'bash' || language === 'sh' || language === 'shell') {
    const pattern = /#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\w+|\b\d+\b|\b(?:if|then|fi|for|do|done|while|case|esac|function|echo|export|cd|ls|cat|grep|awk|sed)\b|[(){}[\];|&<>]/gm;
    return tokenizeByPattern(code, pattern, (value) => classifyShellToken(value));
  }
  return [{ text: code }];
}

function tokenizeByPattern(
  code: string,
  pattern: RegExp,
  classify: (value: string, source: string, index: number) => Token['type']
): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = pattern.exec(code);
  while (match) {
    const value = match[0];
    const index = match.index;
    if (index > cursor) {
      tokens.push({ text: code.slice(cursor, index) });
    }
    tokens.push({ text: value, type: classify(value, code, index) });
    cursor = index + value.length;
    match = pattern.exec(code);
  }
  if (cursor < code.length) {
    tokens.push({ text: code.slice(cursor) });
  }
  return tokens;
}

function formatLanguageLabel(language: string): string {
  const map: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'JSX',
    ts: 'TypeScript',
    tsx: 'TSX',
    json: 'JSON',
    python: 'Python',
    py: 'Python',
    bash: 'Bash',
    sh: 'Shell',
    shell: 'Shell',
    text: 'Text'
  };
  return map[language] || language.toUpperCase();
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function isJsLike(language: string): boolean {
  return ['js', 'jsx', 'javascript', 'ts', 'tsx', 'typescript', 'mjs', 'cjs'].includes(language);
}

function classifyJsToken(value: string): Token['type'] {
  if (value.startsWith('//') || value.startsWith('/*')) return 'comment';
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) return 'string';
  if (/^\d/.test(value)) return 'number';
  if (/^(true|false|null|undefined)$/.test(value)) return 'boolean';
  if (/^[A-Za-z_]/.test(value)) return 'keyword';
  return 'operator';
}

function classifyJsonToken(value: string, source: string, index: number): Token['type'] {
  if (value.startsWith('"')) {
    const tail = source.slice(index + value.length);
    return /^\s*:/.test(tail) ? 'property' : 'string';
  }
  if (/^(true|false)$/i.test(value)) return 'boolean';
  if (/^null$/i.test(value)) return 'keyword';
  if (/^-?\d/.test(value)) return 'number';
  return 'operator';
}

function classifyPythonToken(value: string): Token['type'] {
  if (value.startsWith('#')) return 'comment';
  if (value.startsWith('"') || value.startsWith("'")) return 'string';
  if (/^\d/.test(value)) return 'number';
  if (/^(True|False|None)$/.test(value)) return 'boolean';
  if (/^[A-Za-z_]/.test(value)) return 'keyword';
  return 'operator';
}

function classifyShellToken(value: string): Token['type'] {
  if (value.startsWith('#')) return 'comment';
  if (value.startsWith('"') || value.startsWith("'")) return 'string';
  if (value.startsWith('$')) return 'property';
  if (/^\d/.test(value)) return 'number';
  if (/^[A-Za-z_]/.test(value)) return 'command';
  return 'operator';
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [mode, setMode] = useState<AssistantMode>('ask');
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [currentModel, setCurrentModel] = useState('llama3');
  const [temperature, setTemperature] = useState(0.1);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>('auto_light');
  const [contextScope, setContextScope] = useState<ContextScope>({
    useSelection: true,
    useActiveFile: true,
    useOpenFiles: false,
    useProjectMap: false
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, PendingApproval>>({});
  const [patchProposals, setPatchProposals] = useState<Record<string, PatchProposal>>({});
  const [selectionContextBySession, setSelectionContextBySession] = useState<Record<string, SelectionContextInfo>>({});
  const [pendingSelectionReplace, setPendingSelectionReplace] = useState<Record<string, PendingSelectionReplace>>({});
  const [selectionUndoByTurn, setSelectionUndoByTurn] = useState<Record<string, SelectionReplaceState>>({});
  const [openMenu, setOpenMenu] = useState<null | 'mode' | 'model' | 'temp'>(null);
  const [showSessionsFeed, setShowSessionsFeed] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [transientEvents, setTransientEvents] = useState<TransientEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId), [sessions, activeSessionId]);
  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const timeline = useMemo(() => activeSession?.timeline ?? [], [activeSession]);
  const attachments = useMemo(() => activeSession?.attachments ?? [], [activeSession]);
  const streamForSession = streamingText[activeSessionId] || '';
  const activeSelectionContext = selectionContextBySession[activeSessionId];
  const hasConversation = messages.length > 0 || timeline.length > 0 || isStreaming;

  const filteredTimeline = useMemo(
    () => timeline.filter((event) => !(event.type === 'system' && event.title === 'Turn complete')),
    [timeline]
  );

  const sessionTransient = useMemo(
    () => transientEvents.filter((event) => event.sessionId === activeSessionId),
    [transientEvents, activeSessionId]
  );

  const feedItems = useMemo(() => {
    const merged: FeedItem[] = [];
    for (const message of messages) {
      merged.push({ kind: 'message', id: `m_${message.id}`, createdAt: message.createdAt, message });
    }
    for (const event of filteredTimeline) {
      merged.push({ kind: 'event', id: `e_${event.id}`, createdAt: event.createdAt, event });
    }
    for (const event of sessionTransient) {
      merged.push({ kind: 'event', id: `t_${event.id}`, createdAt: event.createdAt, event });
    }
    merged.sort((a, b) => a.createdAt - b.createdAt);
    return merged;
  }, [messages, filteredTimeline, sessionTransient]);

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
          setTemperature(active?.temperature ?? 0.1);
          setContextPolicy(active?.contextPolicy ?? 'auto_light');
          setContextScope(active?.contextScope ?? {
            useSelection: true,
            useActiveFile: true,
            useOpenFiles: false,
            useProjectMap: false
          });
          setSelectionContextBySession({});
          setPendingSelectionReplace({});
          setSelectionUndoByTurn({});
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
            setTemperature(typeof message.session.temperature === 'number' ? message.session.temperature : 0.1);
            setContextPolicy(message.session.contextPolicy ?? 'auto_light');
            setContextScope(message.session.contextScope ?? {
              useSelection: true,
              useActiveFile: true,
              useOpenFiles: false,
              useProjectMap: false
            });
          }
          break;
        case 'session_deleted':
          setSessions((prev) => prev.filter((session) => session.id !== message.sessionId));
          setActiveSessionId(message.activeSessionId || '');
          setSelectionContextBySession((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setPendingSelectionReplace((prev) => Object.fromEntries(
            Object.entries(prev).filter(([, entry]) => entry.sessionId !== message.sessionId)
          ));
          setSelectionUndoByTurn((prev) => Object.fromEntries(
            Object.entries(prev).filter(([, entry]) => entry.sessionId !== message.sessionId)
          ));
          break;
        case 'models_updated':
          setModels(message.models || []);
          setCurrentModel((prev) => message.currentModel || prev);
          break;
        case 'temperature_updated':
          setTemperature(message.temperature ?? 0.1);
          break;
        case 'turn_started':
          setIsStreaming(true);
          setShowSessionsFeed(false);
          setStreamingText((prev) => ({ ...prev, [message.sessionId]: '' }));
          setSelectionContextBySession((prev) => {
            const next = { ...prev };
            delete next[message.sessionId];
            return next;
          });
          setPendingSelectionReplace((prev) => Object.fromEntries(
            Object.entries(prev).filter(([, entry]) => entry.sessionId !== message.sessionId)
          ));
          break;
        case 'token_stream':
          setStreamingText((prev) => ({
            ...prev,
            [message.sessionId]: `${prev[message.sessionId] || ''}${message.delta || ''}`
          }));
          break;
        case 'trace_stream':
          setTransientEvents((prev) => [
            ...prev.slice(-250),
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: message.sessionId,
              turnId: message.turnId,
              createdAt: Date.now(),
              title: message.text,
              status: 'running'
            }
          ]);
          break;
        case 'context_used':
          setTransientEvents((prev) => [
            ...prev.slice(-250),
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: message.sessionId,
              turnId: message.turnId,
              createdAt: Date.now(),
              title: `Context used: ${(message.scopes || []).join(', ') || 'None'}`,
              detail: (message.citations || []).slice(0, 6).join(', '),
              status: 'info'
            }
          ]);
          break;
        case 'selection_context':
          setSelectionContextBySession((prev) => ({
            ...prev,
            [message.sessionId]: {
              sessionId: message.sessionId,
              turnId: message.turnId,
              filePath: message.filePath,
              range: message.range,
              chars: message.chars
            }
          }));
          break;
        case 'selection_replace_ready': {
          const key = `${message.sessionId}:${message.turnId}`;
          setPendingSelectionReplace((prev) => ({
            ...prev,
            [key]: {
              sessionId: message.sessionId,
              turnId: message.turnId,
              filePath: message.filePath,
              range: message.range
            }
          }));
          break;
        }
        case 'selection_replaced': {
          const key = `${message.sessionId}:${message.turnId}`;
          setPendingSelectionReplace((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setSelectionUndoByTurn((prev) => ({
            ...prev,
            [key]: {
              sessionId: message.sessionId,
              turnId: message.turnId,
              filePath: message.filePath,
              range: message.range,
              mode: message.mode
            }
          }));
          setTransientEvents((prev) => [
            ...prev.slice(-250),
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: message.sessionId,
              turnId: message.turnId,
              createdAt: Date.now(),
              title: `Selection replaced: ${message.filePath} (${message.range})`,
              status: 'success'
            }
          ]);
          break;
        }
        case 'selection_undone': {
          const key = `${message.sessionId}:${message.turnId}`;
          setSelectionUndoByTurn((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setTransientEvents((prev) => [
            ...prev.slice(-250),
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: message.sessionId,
              turnId: message.turnId,
              createdAt: Date.now(),
              title: `Selection undo complete: ${message.filePath}`,
              status: 'info'
            }
          ]);
          break;
        }
        case 'selection_replace_failed':
          setTransientEvents((prev) => [
            ...prev.slice(-250),
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: message.sessionId,
              turnId: message.turnId,
              createdAt: Date.now(),
              title: 'Selection replace failed',
              detail: message.message,
              status: 'error'
            }
          ]);
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
          setStreamingText((prev) => ({ ...prev, [message.sessionId]: '' }));
          setTransientEvents((prev) => prev.filter((entry) => !(entry.sessionId === message.sessionId && entry.turnId === message.turnId)));
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
  }, [feedItems, streamForSession, isStreaming, showSessionsFeed]);

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

  const sendTurn = () => {
    if (!activeSessionId || !input.trim() || isStreaming) return;
    setShowSessionsFeed(false);
    vscode.postMessage({
      type: 'send_turn',
      sessionId: activeSessionId,
      mode,
      model: currentModel,
      temperature,
      contextPolicy,
      contextScope,
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
      mode,
      model: currentModel,
      temperature,
      contextPolicy,
      contextScope,
      text: prompt
    });
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

  const updateTemperature = (value: number) => {
    const next = Math.max(0, Math.min(2, Math.round(value * 10) / 10));
    setTemperature(next);
    vscode.postMessage({ type: 'set_temperature', temperature: next });
  };

  const updateContextPolicy = (policy: ContextPolicy) => {
    setContextPolicy(policy);
    vscode.postMessage({ type: 'set_context_policy', contextPolicy: policy });
  };

  const updateScope = (key: keyof ContextScope) => {
    const next = { ...contextScope, [key]: !contextScope[key] };
    setContextScope(next);
    vscode.postMessage({ type: 'set_context_scope', contextScope: next });
  };

  const decideApproval = (actionId: string, approved: boolean) => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'approve_action', sessionId: activeSessionId, actionId, approved });
    if (!approved) {
      setPendingApprovals((prev) => {
        const next = { ...prev };
        delete next[actionId];
        return next;
      });
      setPatchProposals((prev) => {
        const next = { ...prev };
        delete next[actionId];
        return next;
      });
    }
  };

  const applySelectionReplace = (turnId: string) => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'apply_selection_replace', sessionId: activeSessionId, turnId });
  };

  const dismissSelectionReplace = (turnId: string) => {
    const key = `${activeSessionId}:${turnId}`;
    setPendingSelectionReplace((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const undoSelectionReplace = (turnId: string) => {
    if (!activeSessionId) return;
    vscode.postMessage({ type: 'undo_selection_replace', sessionId: activeSessionId, turnId });
  };

  const approvalsForActiveSession = Object.values(pendingApprovals).filter((entry) => entry.sessionId === activeSessionId);
  const selectionReplaceForActiveSession = Object.values(pendingSelectionReplace).filter((entry) => entry.sessionId === activeSessionId);
  const selectionUndoForActiveSession = Object.values(selectionUndoByTurn).filter((entry) => entry.sessionId === activeSessionId);
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  const activeTitle = (activeSession?.title || 'New Chat').toUpperCase();

  return (
    <IconoirProvider iconProps={{ color: 'currentColor', strokeWidth: 1.9 }}>
      <div className="shell">
      <header className="top-toolbar">
        <div className="toolbar-title">CHAT</div>
        <div className="toolbar-actions">
          <button className="chrome-btn" onClick={() => setShowSessionsFeed((prev) => !prev)} title="Toggle sessions">
            <Clock width={14} height={14} />
          </button>
          <button className="chrome-btn" onClick={onCreateSession} title="New chat">
            <Plus width={14} height={14} />
          </button>
          <button className="chrome-btn" onClick={() => vscode.postMessage({ type: 'open_settings' })} title="Settings">
            <Settings width={14} height={14} />
          </button>
          <button className="chrome-btn" onClick={onDeleteSession} title="Delete session">
            <Bin width={14} height={14} />
          </button>
        </div>
      </header>

      <div className="session-header">
        <span className="active-title">{activeTitle}</span>
      </div>

      <main className="conversation" ref={scrollRef}>
        {showSessionsFeed && (
          <section className="sessions-feed">
            <div className="sessions-head">SESSIONS</div>
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`session-row ${session.id === activeSessionId ? 'active' : ''}`}
                onClick={() => onSwitchSession(session.id)}
              >
                <div className="session-dot" />
                <div className="session-body">
                  <div className="session-name">{session.title}</div>
                  <div className="session-sub">{session.timeline.at(-1)?.title ?? 'No activity yet.'}</div>
                </div>
                <div className="session-time">{formatRelativeTime(session.updatedAt)}</div>
              </button>
            ))}
          </section>
        )}

        {!showSessionsFeed && !hasConversation && (
          <div className="empty-state">
            <MessageText width={34} height={34} />
            <h2>Build with Agent</h2>
            <p>AI responses may be inaccurate.</p>
            <div className="suggested-row">
              {SUGGESTED_ACTIONS.map((label) => (
                <button key={label} className="chip" onClick={() => askSuggested(label)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!showSessionsFeed && feedItems.map((item) => {
          if (item.kind === 'message') {
            const message = item.message;
            return (
              <div key={item.id} className={`msg ${message.role}`}>
                {message.role === 'user' ? (
                  <div className="user-bubble">{message.content}</div>
                ) : (
                  <div className="assistant-content markdown-body">
                    <MarkdownContent content={message.content} />
                  </div>
                )}
              </div>
            );
          }
          const event = item.event;
          const title = (event as TimelineEvent).title ?? (event as TransientEvent).title;
          const detail = (event as TimelineEvent).detail ?? (event as TransientEvent).detail;
          const status = (event as TimelineEvent).status ?? (event as TransientEvent).status;
          return (
            <div key={item.id} className={`event-row ${status}`}>
              <button
                className="event-main"
                onClick={() => {
                  if (!detail) return;
                  setExpandedEvents((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
                }}
              >
                <span className="event-icon">{status === 'running' ? <Refresh width={12} height={12} className="spin" /> : <NavArrowDown width={12} height={12} />}</span>
                <span className="event-title">{title}</span>
                {detail && (expandedEvents[item.id] ? <NavArrowDown width={12} height={12} className="event-toggle open" /> : <NavArrowDown width={12} height={12} className="event-toggle" />)}
              </button>
              {detail && <div className={`event-detail ${expandedEvents[item.id] ? 'open' : ''}`}>{detail}</div>}
            </div>
          );
        })}

        {!showSessionsFeed && isStreaming && streamForSession && (
          <div className="msg assistant">
            <div className="assistant-content markdown-body streaming">
              <MarkdownContent content={streamForSession} />
              <span className="typing-caret" />
            </div>
          </div>
        )}

        {!showSessionsFeed && approvalsForActiveSession.map((approval) => {
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
                <button className="ok" onClick={() => decideApproval(approval.actionId, true)}>Approve</button>
                <button className="no" onClick={() => decideApproval(approval.actionId, false)}>Deny</button>
              </div>
            </div>
          );
        })}

        {!showSessionsFeed && selectionReplaceForActiveSession.map((entry) => (
          <div key={`selection_ready_${entry.turnId}`} className="approval-card selection-card">
            <div className="approval-head">Replace Selection?</div>
            <div className="approval-summary">{entry.filePath} ({entry.range})</div>
            <div className="approval-reason">Apply the latest assistant response to the selected text.</div>
            <div className="approval-actions">
              <button className="ok" onClick={() => applySelectionReplace(entry.turnId)}>Apply</button>
              <button className="no" onClick={() => dismissSelectionReplace(entry.turnId)}>Not now</button>
            </div>
          </div>
        ))}

        {!showSessionsFeed && selectionUndoForActiveSession.map((entry) => (
          <div key={`selection_undo_${entry.turnId}`} className="approval-card selection-card">
            <div className="approval-head">Selection Updated</div>
            <div className="approval-summary">{entry.filePath} ({entry.range})</div>
            <div className="approval-reason">{entry.mode === 'agent_auto' ? 'Applied automatically in Agent mode.' : 'Applied after your confirmation.'}</div>
            <div className="approval-actions">
              <button className="ok" onClick={() => undoSelectionReplace(entry.turnId)}>Undo</button>
            </div>
          </div>
        ))}
      </main>

      <footer className="composer">
        {activeSelectionContext && (
          <div className="selection-context">
            Selection: {activeSelectionContext.filePath} ({activeSelectionContext.range}) - {activeSelectionContext.chars} chars
          </div>
        )}
        <div className="composer-panel">
          <div className="composer-meta-row">
            <button className="context-btn context-inline" onClick={onAttachContext}>
              <Attachment width={12} height={12} />
              Add Context...
            </button>
            <div className="attachments-row inline">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="attachment-chip">
                  <span>{attachment.name}</span>
                  <button onClick={() => onDetachAttachment(attachment.id)}>
                    <Xmark width={11} height={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="scope-row scope-inline">
            <button className={`scope-chip ${contextScope.useSelection ? 'on' : ''}`} onClick={() => updateScope('useSelection')}>Selection</button>
            <button className={`scope-chip ${contextScope.useActiveFile ? 'on' : ''}`} onClick={() => updateScope('useActiveFile')}>File</button>
            <button className={`scope-chip ${contextScope.useOpenFiles ? 'on' : ''}`} onClick={() => updateScope('useOpenFiles')}>Open Files</button>
            <button className={`scope-chip ${contextScope.useProjectMap ? 'on' : ''}`} onClick={() => updateScope('useProjectMap')}>Project</button>
          </div>

          <textarea
            ref={textareaRef}
            className="input-box composer-input"
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

          <div className="composer-bottom composer-dock">
            <div className="bottom-left">
              <div className="menu-root">
                <button className="pill-btn" onClick={() => setOpenMenu((prev) => (prev === 'mode' ? null : 'mode'))}>
                  {modeLabel}
                  <NavArrowDown width={12} height={12} className={openMenu === 'mode' ? 'chev open' : 'chev'} />
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
                        {entry === mode && <Check width={12} height={12} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="menu-root">
                <button className="pill-btn model-pill" onClick={() => setOpenMenu((prev) => (prev === 'model' ? null : 'model'))}>
                  <span>{currentModel}</span>
                  <NavArrowDown width={12} height={12} className={openMenu === 'model' ? 'chev open' : 'chev'} />
                </button>
                {openMenu === 'model' && (
                  <div className="menu-panel bottom-menu model-menu">
                    {(models.length > 0 ? models : [{ name: currentModel, toolCalling: true, vision: false }]).map((model) => (
                      <button
                        key={model.name}
                        className={`menu-item ${model.name === currentModel ? 'selected' : ''}`}
                        onClick={() => {
                          setCurrentModel(model.name);
                          vscode.postMessage({ type: 'set_model', model: model.name });
                          setOpenMenu(null);
                        }}
                      >
                        <span>{model.name}</span>
                        {model.name === currentModel && <Check width={12} height={12} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="menu-root">
                <button className="pill-btn" onClick={() => setOpenMenu((prev) => (prev === 'temp' ? null : 'temp'))}>
                  <ControlSlider width={12} height={12} />
                  {temperature.toFixed(1)}
                </button>
                {openMenu === 'temp' && (
                  <div className="menu-panel bottom-menu temp-menu">
                    <div className="temp-head">Temperature</div>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperature}
                      onChange={(e) => updateTemperature(Number(e.target.value))}
                    />
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperature}
                      onChange={(e) => updateTemperature(Number(e.target.value))}
                    />
                  </div>
                )}
              </div>

              <div className="menu-root">
                <button className="pill-btn" onClick={() => updateContextPolicy(contextPolicy === 'auto_light' ? 'manual_only' : contextPolicy === 'manual_only' ? 'always_project' : 'auto_light')}>
                  {contextPolicy === 'auto_light' ? 'Auto' : contextPolicy === 'manual_only' ? 'Manual' : 'Project'}
                </button>
              </div>

              <button className="mini-btn" onClick={() => vscode.postMessage({ type: 'refresh_models' })} title="Refresh models">
                <Refresh width={12} height={12} />
              </button>
            </div>

            <button className={`send send-prominent ${input.trim() ? 'active' : ''}`} onClick={sendTurn} disabled={isStreaming || !activeSessionId}>
              <SendDiagonal width={15} height={15} />
            </button>
          </div>
        </div>
      </footer>
      </div>
    </IconoirProvider>
  );
}

export default App;
