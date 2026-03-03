import * as vscode from 'vscode';
import { ChatWebviewProvider } from './ChatWebviewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Olla Chat extension is now active!');

    const provider = new ChatWebviewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('olla-chat.sidebar.view', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('olla-chat.focus', () => {
            vscode.commands.executeCommand('olla-chat.sidebar.view.focus');
        })
    );
}

export function deactivate() { }
