import * as vscode from 'vscode';
import { OllamaAgent } from './agent/OllamaAgent';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'olla-chat.sidebar.view';
    private _view?: vscode.WebviewView;
    private _agent = new OllamaAgent();

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    {
                        // Begin streaming response from Ollama
                        webviewView.webview.postMessage({ type: 'startStream' });

                        await this._agent.sendMessage(
                            data.value,
                            (chunk: string) => {
                                webviewView.webview.postMessage({ type: 'streamChunk', value: chunk });
                            },
                            (isThinking: boolean, statusText?: string) => {
                                webviewView.webview.postMessage({ type: 'thinkStatus', value: isThinking, statusText: statusText });
                            }
                        );

                        webviewView.webview.postMessage({ type: 'endStream' });
                        break;
                    }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get path to React build
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'build', 'assets', 'index.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'build', 'assets', 'index.css')
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
