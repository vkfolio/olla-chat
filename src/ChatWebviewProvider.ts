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
                case 'openSettings':
                    {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'olla-chat');
                        break;
                    }
                case 'setModel':
                    {
                        vscode.workspace.getConfiguration('olla-chat').update('ollamaModel', data.value, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(`Olla Chat model set to: ${data.value}`);
                        break;
                    }
                case 'refreshModels':
                    {
                        const models = await this._agent.getAvailableModels();
                        webviewView.webview.postMessage({ type: 'initModels', value: models });
                        break;
                    }
            }
        });

        // Fetch initial models on load
        this._agent.getAvailableModels().then(models => {
            webviewView.webview.postMessage({ type: 'initModels', value: models });
        });

        // Push the currently selected model
        const currentModel = vscode.workspace.getConfiguration('olla-chat').get<string>('ollamaModel', 'llama3');
        webviewView.webview.postMessage({ type: 'currentModel', value: currentModel });
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
