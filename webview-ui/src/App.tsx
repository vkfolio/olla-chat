import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, SplitSquareHorizontal, Paperclip, Monitor, ListTree, Settings, Send, Loader2, Check } from 'lucide-react'
import './App.css'

// @ts-ignore
const vscode = acquireVsCodeApi();

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  isThinking?: boolean;
  statusText?: string;
}

function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  // Read messages back from the Extension Host
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case 'startStream':
          setIsStreaming(true);
          setMessages((prev) => [...prev, { role: 'assistant', content: '', isThinking: false }]);
          break;
        case 'streamChunk':
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              lastMessage.content += message.value;
            }
            return newMessages;
          });
          break;
        case 'thinkStatus':
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              lastMessage.isThinking = message.value;
              lastMessage.statusText = message.statusText || 'Thinking...';
            }
            return newMessages;
          });
          break;
        case 'endStream':
          setIsStreaming(false);
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              lastMessage.isThinking = false;
            }
            return newMessages;
          });
          break;
      }
    };

    window.addEventListener('message', handleMessage);

    // Initial greeting!
    setMessages([
      { role: 'assistant', content: 'Hi! What would you like to build or fix in your code?' }
    ]);

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;

    setMessages((prev) => [...prev, { role: 'user', content: input }]);
    vscode.postMessage({ type: 'sendMessage', value: input });
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '40px'; // Reset height
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const adjustTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '40px';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight);
    return () => window.removeEventListener('resize', adjustTextareaHeight);
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    adjustTextareaHeight();
  };

  return (
    <>
      <div className="header">
        <div className="header-title">
          <ArrowLeft size={16} style={{ cursor: 'pointer' }} />
          GENERAL GREETING AND INTRODUCTION
        </div>
        <div className="header-actions">
          <div className="icon-button">
            <SplitSquareHorizontal size={14} />
          </div>
        </div>
      </div>

      <div className="chat-container" ref={scrollRef}>
        {messages.map((msg, idx) => (
          <div key={idx} className={`message-wrapper ${msg.role}`}>

            {msg.role === 'assistant' && msg.isThinking && (
              <div className="action-block">
                <div className="action-header">
                  <Loader2 size={12} className="lucide-spin" style={{ animation: 'spin 2s linear infinite' }} />
                  {msg.statusText || 'Thinking...'}
                </div>
              </div>
            )}
            {msg.role === 'assistant' && !msg.isThinking && idx > 0 && messages[idx - 1]?.isThinking && (
              <div className="action-block">
                <div className="action-header completed">
                  <Check size={12} />
                  Tool execution complete
                </div>
              </div>
            )}

            <div className={`message-content ${msg.role === 'user' ? 'message-user' : 'message-assistant'}`}>
              {msg.role === 'user' ? (
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
              ) : (
                <div className="markdown-body">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        ))}
        <div style={{ paddingBottom: '10px' }} />
      </div>

      <div className="input-container">
        <div className="input-widget">
          <div className="input-toolbar-top">
            <button className="add-context-btn">
              <Paperclip size={12} /> Add Context...
            </button>
          </div>

          <textarea
            ref={textareaRef}
            className="input-box"
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "Wait for response..." : "Describe what to build next"}
            disabled={isStreaming}
            rows={1}
          />

          <div className="input-toolbar-bottom">
            <div className="toolbar-group-left">
              <div className="tiny-toolbar-btn">
                <Monitor size={12} /> <span style={{ fontSize: '9px' }}>▼</span>
              </div>
              <div className="tiny-toolbar-btn">
                <ListTree size={12} /> Plan <span style={{ fontSize: '9px' }}>▼</span>
              </div>
              <div className="tiny-toolbar-btn">
                Ollama Llama3 <span style={{ fontSize: '9px' }}>▼</span>
              </div>
              <div className="tiny-toolbar-btn">
                <Settings size={12} />
              </div>
            </div>
            <div className="toolbar-group-right">
              <div className={`send-btn ${input.trim() ? 'active' : ''}`} onClick={handleSend}>
                <Send size={14} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default App
