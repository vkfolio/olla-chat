import * as vscode from 'vscode';
import { ChatWebviewProvider } from './ChatWebviewProvider';
import { debugLog, initializeDebugLogger, showDebugLogger } from './runtime/DebugLogger';

export function activate(context: vscode.ExtensionContext) {
    initializeDebugLogger(context);
    debugLog('Extension', 'Activating Olla Chat extension');

    const provider = new ChatWebviewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('olla-chat.sidebar.view', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('olla-chat.focus', () => {
            vscode.commands.executeCommand('olla-chat.sidebar.view.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('olla-chat.showDebugLogs', () => {
            showDebugLogger();
        })
    );

    debugLog('Extension', 'Activation complete');
}

export function deactivate() {
    debugLog('Extension', 'Extension deactivated');
}
