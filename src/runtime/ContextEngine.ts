import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AttachmentMeta, AssistantMode } from '../types/protocol';

interface ContextResult {
    text: string;
    citations: string[];
}

export class ContextEngine {
    public async buildContext(userText: string, mode: AssistantMode, attachments: AttachmentMeta[]): Promise<ContextResult> {
        const sections: string[] = [];
        const citations: string[] = [];

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            citations.push(document.fileName);
            if (!editor.selection.isEmpty) {
                sections.push(
                    `Active selection from ${document.fileName}:\n` +
                    '```\n' +
                    `${document.getText(editor.selection).slice(0, 4000)}\n` +
                    '```'
                );
            } else {
                sections.push(
                    `Active file excerpt (${document.fileName}):\n` +
                    '```\n' +
                    `${document.getText().slice(0, 2000)}\n` +
                    '```'
                );
            }
        }

        const openEditors = vscode.window.visibleTextEditors
            .map((visible) => visible.document.fileName)
            .slice(0, 8);
        if (openEditors.length > 0) {
            sections.push(`Open editors:\n- ${openEditors.join('\n- ')}`);
            citations.push(...openEditors);
        }

        const workspaceFiles = await vscode.workspace.findFiles(
            '**/*.{ts,tsx,js,jsx,json,md,css}',
            '**/{node_modules,dist,build,out,.git}/**',
            80
        );
        const fileHints = workspaceFiles.map((uri) => this.asWorkspaceRelative(uri.fsPath));
        if (fileHints.length > 0) {
            sections.push(`Repository map (${fileHints.length} files sampled):\n- ${fileHints.join('\n- ')}`);
            citations.push(...workspaceFiles.map((uri) => uri.fsPath));
        }

        if (attachments.length > 0) {
            const attachmentSections = attachments.map((attachment) => {
                const snippet = attachment.snippet ?? this.safeReadFileSnippet(attachment.path);
                citations.push(attachment.path);
                return `Attachment: ${attachment.name} (${attachment.kind})\n` +
                    '```\n' +
                    `${snippet}\n` +
                    '```';
            });
            sections.push(attachmentSections.join('\n\n'));
        }

        const modeHint = `Mode: ${mode}. User request: ${userText}`;
        sections.unshift(modeHint);

        return {
            text: sections.join('\n\n'),
            citations: Array.from(new Set(citations)).slice(0, 80)
        };
    }

    private asWorkspaceRelative(filePath: string): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return filePath;
        }
        return path.relative(root, filePath) || filePath;
    }

    private safeReadFileSnippet(filePath: string): string {
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > 250_000) {
                return '[Attachment too large to inline context. The agent can read it on demand.]';
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            return content.slice(0, 3000);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return `Unable to read attachment: ${message}`;
        }
    }
}
