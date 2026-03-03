import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AttachmentMeta, AssistantMode, ContextPolicy, ContextScope } from '../types/protocol';
import { debugLog } from './DebugLogger';

interface ContextResult {
    text: string;
    citations: string[];
    scopesUsed: string[];
}

interface BuildContextOptions {
    mode: AssistantMode;
    policy: ContextPolicy;
    scope: ContextScope;
}

export class ContextEngine {
    public async buildContext(
        userText: string,
        attachments: AttachmentMeta[],
        options: BuildContextOptions
    ): Promise<ContextResult> {
        const { mode, policy, scope } = options;
        debugLog('ContextEngine', 'Building context', {
            mode,
            policy,
            scope,
            textLength: userText.length,
            attachments: attachments.length
        });
        const sections: string[] = [];
        const citations: string[] = [];
        const scopesUsed: string[] = [];
        const isCodeIntent = this.isCodeIntent(userText, mode);
        const shouldUseWorkspace =
            policy === 'always_project' ||
            (policy === 'auto_light' && isCodeIntent);

        const editor = vscode.window.activeTextEditor;
        if (editor && shouldUseWorkspace) {
            const document = editor.document;
            if (scope.useSelection && !editor.selection.isEmpty) {
                citations.push(document.fileName);
                scopesUsed.push('Selection');
                sections.push(
                    `Selected code from ${document.fileName}:\n` +
                    '```\n' +
                    `${document.getText(editor.selection).slice(0, 4000)}\n` +
                    '```'
                );
            } else if (scope.useActiveFile) {
                citations.push(document.fileName);
                scopesUsed.push('Active File');
                sections.push(
                    `Active file excerpt (${document.fileName}):\n` +
                    '```\n' +
                    `${document.getText().slice(0, 2000)}\n` +
                    '```'
                );
            }
        }

        if (scope.useOpenFiles && shouldUseWorkspace) {
            const openEditors = vscode.window.visibleTextEditors
                .map((visible) => visible.document.fileName)
                .slice(0, 8);
            if (openEditors.length > 0) {
                scopesUsed.push('Open Files');
                sections.push(`Open editors:\n- ${openEditors.join('\n- ')}`);
                citations.push(...openEditors);
            }
        }

        if (scope.useProjectMap && shouldUseWorkspace) {
            const workspaceFiles = await vscode.workspace.findFiles(
                '**/*.{ts,tsx,js,jsx,json,md,css,py,go,rs,java,kt,c,cpp,h,cs,php,rb,swift}',
                '**/{node_modules,dist,build,out,.git,venv,.next,.turbo,.cache}/**',
                80
            );
            const fileHints = workspaceFiles.map((uri) => this.asWorkspaceRelative(uri.fsPath));
            if (fileHints.length > 0) {
                scopesUsed.push('Project Map');
                sections.push(`Repository map (${fileHints.length} files sampled):\n- ${fileHints.join('\n- ')}`);
                citations.push(...workspaceFiles.map((uri) => uri.fsPath));
            }
        }

        if (attachments.length > 0) {
            scopesUsed.push('Attachments');
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

        const modeHint = `Mode: ${mode}. Context policy: ${policy}. User request: ${userText}`;
        sections.unshift(modeHint);

        const result = {
            text: sections.join('\n\n'),
            citations: Array.from(new Set(citations)).slice(0, 80),
            scopesUsed: Array.from(new Set(scopesUsed))
        };
        debugLog('ContextEngine', 'Context build complete', {
            scopesUsed: result.scopesUsed,
            citations: result.citations.length,
            contextLength: result.text.length
        });
        return result;
    }

    private isCodeIntent(userText: string, mode: AssistantMode): boolean {
        if (mode === 'agent' || mode === 'plan') {
            return true;
        }
        const text = userText.toLowerCase();
        return /(file|code|function|class|bug|fix|error|build|test|refactor|implement|repository|project|typescript|python|javascript)/.test(text);
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
