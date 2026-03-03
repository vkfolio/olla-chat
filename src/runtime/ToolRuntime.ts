import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AssistantMode, ProposedPatch } from '../types/protocol';
import { createId } from './id';

interface ToolSchema {
    name: string;
    description: string;
    schema: {
        type: 'object';
        properties: Record<string, { type: string; description: string }>;
        required: string[];
    };
}

export interface PendingApprovalAction {
    id: string;
    type: 'patch' | 'command';
    sessionId: string;
    toolCallId: string;
    summary: string;
    reason: string;
    createdAt: number;
    patches?: ProposedPatch[];
    command?: string;
}

export type ToolExecutionResult =
    | { kind: 'completed'; output: string }
    | { kind: 'needs_approval'; action: PendingApprovalAction; preview: string };

export class ToolRuntime {
    private readonly pendingActions = new Map<string, PendingApprovalAction>();

    public getToolSchemas(mode: AssistantMode): ToolSchema[] {
        if (mode === 'ask') {
            return [];
        }
        if (mode === 'plan') {
            return [
                this.readFileSchema(),
                this.listDirSchema(),
                this.searchTextSchema(),
                this.getSymbolsSchema()
            ];
        }
        return [
            this.readFileSchema(),
            this.listDirSchema(),
            this.searchTextSchema(),
            this.getSymbolsSchema(),
            this.proposePatchSchema(),
            this.runCommandSchema()
        ];
    }

    public async executeToolCall(sessionId: string, toolCallId: string, toolName: string, args: unknown): Promise<ToolExecutionResult> {
        switch (toolName) {
            case 'read_file':
                return { kind: 'completed', output: await this.readFile(args) };
            case 'list_dir':
                return { kind: 'completed', output: await this.listDir(args) };
            case 'search_text':
                return { kind: 'completed', output: await this.searchText(args) };
            case 'get_symbols':
                return { kind: 'completed', output: await this.getSymbols(args) };
            case 'propose_patch':
                return this.proposePatch(sessionId, toolCallId, args);
            case 'run_command':
                return this.proposeCommand(sessionId, toolCallId, args);
            default:
                return { kind: 'completed', output: `Unknown tool: ${toolName}` };
        }
    }

    public async resolvePendingAction(sessionId: string, actionId: string, approved: boolean): Promise<{ output: string; changedFiles: string[] }> {
        const action = this.pendingActions.get(actionId);
        if (!action || action.sessionId !== sessionId) {
            return { output: `No pending action found for ID ${actionId}.`, changedFiles: [] };
        }

        this.pendingActions.delete(actionId);

        if (!approved) {
            return { output: 'Action rejected by user.', changedFiles: [] };
        }

        if (action.type === 'patch') {
            return this.applyPatchAction(action);
        }

        if (!action.command) {
            return { output: 'Missing command payload.', changedFiles: [] };
        }

        const commandResult = await this.runCommand(action.command);
        return {
            output: commandResult,
            changedFiles: []
        };
    }

    private readFileSchema(): ToolSchema {
        return {
            name: 'read_file',
            description: 'Read the contents of a file in the current workspace.',
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative path.' }
                },
                required: ['path']
            }
        };
    }

    private listDirSchema(): ToolSchema {
        return {
            name: 'list_dir',
            description: 'List files and folders inside a directory.',
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative directory path.' }
                },
                required: ['path']
            }
        };
    }

    private searchTextSchema(): ToolSchema {
        return {
            name: 'search_text',
            description: 'Search text across workspace files.',
            schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Plain text pattern to search for.' },
                    glob: { type: 'string', description: 'Optional glob filter like **/*.ts' }
                },
                required: ['pattern']
            }
        };
    }

    private getSymbolsSchema(): ToolSchema {
        return {
            name: 'get_symbols',
            description: 'Read document symbols from a file using VS Code language providers.',
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative path.' }
                },
                required: ['path']
            }
        };
    }

    private proposePatchSchema(): ToolSchema {
        return {
            name: 'propose_patch',
            description: 'Propose a text replacement patch. Requires user approval before file changes are written.',
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative path to edit.' },
                    findText: { type: 'string', description: 'Existing text segment to replace.' },
                    replaceText: { type: 'string', description: 'Replacement text.' },
                    summary: { type: 'string', description: 'One-line summary of why this edit is needed.' }
                },
                required: ['path', 'findText', 'replaceText']
            }
        };
    }

    private runCommandSchema(): ToolSchema {
        return {
            name: 'run_command',
            description: 'Run a shell command in the workspace. Requires user approval.',
            schema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute.' },
                    summary: { type: 'string', description: 'Why this command is needed.' }
                },
                required: ['command']
            }
        };
    }

    private async readFile(args: unknown): Promise<string> {
        const filePath = this.resolveWorkspacePath(this.readStringArg(args, 'path'));
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return `${filePath} is not a file.`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.slice(0, 12000);
    }

    private async listDir(args: unknown): Promise<string> {
        const dirPath = this.resolveWorkspacePath(this.readStringArg(args, 'path'));
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) {
            return `${dirPath} is not a directory.`;
        }
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 200);
        return entries.map((entry) => `${entry.isDirectory() ? '[D]' : '[F]'} ${entry.name}`).join('\n');
    }

    private async searchText(args: unknown): Promise<string> {
        const pattern = this.readStringArg(args, 'pattern');
        const glob = this.readOptionalStringArg(args, 'glob') ?? '**/*';
        const files = await vscode.workspace.findFiles(
            glob,
            '**/{node_modules,dist,build,out,.git}/**',
            120
        );

        const hits: string[] = [];
        for (const file of files) {
            try {
                const content = fs.readFileSync(file.fsPath, 'utf-8');
                const lines = content.split(/\r?\n/);
                for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                    if (lines[lineIndex].includes(pattern)) {
                        hits.push(`${this.workspaceRelative(file.fsPath)}:${lineIndex + 1}: ${lines[lineIndex].trim()}`);
                    }
                    if (hits.length >= 60) {
                        return hits.join('\n');
                    }
                }
            } catch {
                continue;
            }
        }
        return hits.length > 0 ? hits.join('\n') : 'No matches found.';
    }

    private async getSymbols(args: unknown): Promise<string> {
        const filePath = this.resolveWorkspacePath(this.readStringArg(args, 'path'));
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            vscode.Uri.file(filePath)
        );

        if (!symbols || symbols.length === 0) {
            return 'No symbols found.';
        }

        const flatten = (items: vscode.DocumentSymbol[], depth: number): string[] => {
            const output: string[] = [];
            for (const symbol of items) {
                output.push(`${'  '.repeat(depth)}- ${symbol.name} (${vscode.SymbolKind[symbol.kind]})`);
                output.push(...flatten(symbol.children, depth + 1));
            }
            return output;
        };

        return flatten(symbols, 0).slice(0, 300).join('\n');
    }

    private proposePatch(sessionId: string, toolCallId: string, args: unknown): ToolExecutionResult {
        const targetPath = this.resolveWorkspacePath(this.readStringArg(args, 'path'));
        const findText = this.readStringArg(args, 'findText');
        const replaceText = this.readStringArg(args, 'replaceText');
        const summary = this.readOptionalStringArg(args, 'summary') ?? `Edit ${this.workspaceRelative(targetPath)}`;

        const original = fs.readFileSync(targetPath, 'utf-8');
        if (!original.includes(findText)) {
            return { kind: 'completed', output: `Could not find target text in ${this.workspaceRelative(targetPath)}.` };
        }

        const patch: ProposedPatch = {
            path: this.workspaceRelative(targetPath),
            summary,
            before: findText,
            after: replaceText,
            diff: this.toInlineDiff(this.workspaceRelative(targetPath), findText, replaceText)
        };

        const action: PendingApprovalAction = {
            id: createId('action'),
            type: 'patch',
            sessionId,
            toolCallId,
            summary,
            reason: 'This action modifies workspace files.',
            createdAt: Date.now(),
            patches: [patch]
        };

        this.pendingActions.set(action.id, action);
        return {
            kind: 'needs_approval',
            action,
            preview: patch.diff
        };
    }

    private proposeCommand(sessionId: string, toolCallId: string, args: unknown): ToolExecutionResult {
        const command = this.readStringArg(args, 'command');
        const summary = this.readOptionalStringArg(args, 'summary') ?? `Run command: ${command}`;

        const action: PendingApprovalAction = {
            id: createId('action'),
            type: 'command',
            sessionId,
            toolCallId,
            summary,
            reason: 'This action executes a shell command in your workspace.',
            createdAt: Date.now(),
            command
        };

        this.pendingActions.set(action.id, action);
        return {
            kind: 'needs_approval',
            action,
            preview: command
        };
    }

    private async applyPatchAction(action: PendingApprovalAction): Promise<{ output: string; changedFiles: string[] }> {
        const patches = action.patches ?? [];
        const changedFiles: string[] = [];
        for (const patchEntry of patches) {
            const fullPath = this.resolveWorkspacePath(patchEntry.path);
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (!content.includes(patchEntry.before)) {
                return {
                    output: `Patch failed for ${patchEntry.path}. Expected text was not found.`,
                    changedFiles
                };
            }
            const next = content.replace(patchEntry.before, patchEntry.after);
            fs.writeFileSync(fullPath, next, 'utf-8');
            changedFiles.push(patchEntry.path);
        }
        return {
            output: `Applied ${patches.length} patch(es).`,
            changedFiles
        };
    }

    private async runCommand(command: string): Promise<string> {
        const workspaceRoot = this.getWorkspaceRoot();
        return new Promise((resolve) => {
            cp.exec(command, { cwd: workspaceRoot, timeout: 60_000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve(`Command failed: ${error.message}\n${stderr}`);
                    return;
                }
                resolve((stdout || stderr || 'Command completed with no output.').slice(0, 12000));
            });
        });
    }

    private toInlineDiff(filePath: string, before: string, after: string): string {
        const beforeLines = before.split('\n').map((line) => `-${line}`);
        const afterLines = after.split('\n').map((line) => `+${line}`);
        return [
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            '@@',
            ...beforeLines,
            ...afterLines
        ].join('\n');
    }

    private resolveWorkspacePath(inputPath: string): string {
        const workspaceRoot = this.getWorkspaceRoot();
        const candidate = path.isAbsolute(inputPath)
            ? path.normalize(inputPath)
            : path.normalize(path.join(workspaceRoot, inputPath));
        const normalizedRoot = path.normalize(workspaceRoot).toLowerCase();
        if (!candidate.toLowerCase().startsWith(normalizedRoot)) {
            throw new Error(`Path escapes workspace root: ${inputPath}`);
        }
        return candidate;
    }

    private workspaceRelative(filePath: string): string {
        const workspaceRoot = this.getWorkspaceRoot();
        return path.relative(workspaceRoot, filePath) || path.basename(filePath);
    }

    private getWorkspaceRoot(): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            throw new Error('No workspace folder is open.');
        }
        return root;
    }

    private readStringArg(args: unknown, field: string): string {
        const value = (args as Record<string, unknown> | undefined)?.[field];
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error(`Missing required argument: ${field}`);
        }
        return value;
    }

    private readOptionalStringArg(args: unknown, field: string): string | undefined {
        const value = (args as Record<string, unknown> | undefined)?.[field];
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    }
}
