import * as vscode from 'vscode';
import { ConversationOrchestrator } from './runtime/ConversationOrchestrator';
import { ClientRequest, ServerEvent } from './types/protocol';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'olla-chat.sidebar.view';
    private view?: vscode.WebviewView;
    private readonly orchestrator: ConversationOrchestrator;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.orchestrator = new ConversationOrchestrator(context, (event: ServerEvent) => {
            this.view?.webview.postMessage(event);
        });
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        await this.orchestrator.initialize();

        webviewView.webview.onDidReceiveMessage(async (rawData: unknown) => {
            const data = rawData as Partial<ClientRequest>;
            if (!data || typeof data.type !== 'string') {
                this.view?.webview.postMessage({ type: 'error', message: 'Invalid request payload.' } satisfies ServerEvent);
                return;
            }
            await this.orchestrator.handleClientRequest(data as ClientRequest);
        });

        await this.orchestrator.handleClientRequest({ type: 'bootstrap' });
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
