import * as vscode from 'vscode';
import { ConversationOrchestrator } from './runtime/ConversationOrchestrator';
import { debugError, debugLog } from './runtime/DebugLogger';
import { ClientRequest, ServerEvent } from './types/protocol';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'olla-chat.sidebar.view';
    private view?: vscode.WebviewView;
    private readonly orchestrator: ConversationOrchestrator;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.orchestrator = new ConversationOrchestrator(context, (event: ServerEvent) => {
            debugLog('WebviewProvider', `Emit event ${event.type}`, summarizeServerEvent(event));
            this.view?.webview.postMessage(event);
        });
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Promise<void> {
        debugLog('WebviewProvider', 'Resolving webview view');
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        await this.orchestrator.initialize();
        debugLog('WebviewProvider', 'Orchestrator initialized');

        webviewView.webview.onDidReceiveMessage(async (rawData: unknown) => {
            const data = rawData as Partial<ClientRequest>;
            if (!data || typeof data.type !== 'string') {
                this.view?.webview.postMessage({ type: 'error', message: 'Invalid request payload.' } satisfies ServerEvent);
                debugLog('WebviewProvider', 'Rejected malformed client payload');
                return;
            }
            debugLog('WebviewProvider', `Received request ${data.type}`, summarizeClientRequest(data as ClientRequest));
            try {
                await this.orchestrator.handleClientRequest(data as ClientRequest);
            } catch (error: unknown) {
                debugError('WebviewProvider', `Request ${data.type} failed`, error);
                this.view?.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : String(error)
                } satisfies ServerEvent);
            }
        });

        await this.orchestrator.handleClientRequest({ type: 'bootstrap' });
        debugLog('WebviewProvider', 'Bootstrap request sent');
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'build', 'assets', 'index.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'build', 'assets', 'index.css')
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;">
                <link href="${styleUri}" rel="stylesheet">
                <title>Olla Chat</title>
            </head>
            <body>
                <div id="root"></div>
                <script type="module" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function summarizeClientRequest(request: ClientRequest): Record<string, unknown> {
    switch (request.type) {
        case 'send_turn':
            return {
                sessionId: request.sessionId,
                mode: request.mode,
                model: request.model,
                textLength: request.text.length
            };
        case 'approve_action':
            return {
                sessionId: request.sessionId,
                actionId: request.actionId,
                approved: request.approved
            };
        case 'apply_selection_replace':
        case 'undo_selection_replace':
            return {
                sessionId: request.sessionId,
                turnId: request.turnId
            };
        case 'attach_picker':
        case 'session_switch':
        case 'session_delete':
            return { sessionId: request.sessionId };
        case 'detach_attachment':
            return {
                sessionId: request.sessionId,
                attachmentId: request.attachmentId
            };
        case 'set_model':
            return { model: request.model };
        case 'set_temperature':
            return { temperature: request.temperature };
        case 'set_context_policy':
            return { contextPolicy: request.contextPolicy };
        case 'set_context_scope':
            return request.contextScope;
        case 'session_rename':
            return {
                sessionId: request.sessionId,
                title: request.title
            };
        case 'session_create':
            return { mode: request.mode };
        default:
            return {};
    }
}

function summarizeServerEvent(event: ServerEvent): Record<string, unknown> {
    switch (event.type) {
        case 'bootstrap':
            return {
                sessions: event.sessions.length,
                activeSessionId: event.activeSessionId,
                models: event.models.length,
                currentModel: event.currentModel
            };
        case 'session_updated':
            return {
                sessionId: event.session.id,
                messages: event.session.messages.length,
                timeline: event.session.timeline.length,
                attachments: event.session.attachments.length
            };
        case 'models_updated':
            return {
                currentModel: event.currentModel,
                models: event.models.length
            };
        case 'token_stream':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                deltaLength: event.delta.length
            };
        case 'trace_stream':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                level: event.level,
                textLength: event.text.length
            };
        case 'context_used':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                scopes: event.scopes,
                citations: event.citations.length
            };
        case 'selection_context':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                filePath: event.filePath,
                range: event.range,
                chars: event.chars
            };
        case 'selection_replace_ready':
        case 'selection_replaced':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                filePath: event.filePath,
                range: event.range
            };
        case 'selection_undone':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                filePath: event.filePath
            };
        case 'error':
            return {
                sessionId: event.sessionId,
                turnId: event.turnId,
                message: event.message
            };
        default:
            return {};
    }
}
