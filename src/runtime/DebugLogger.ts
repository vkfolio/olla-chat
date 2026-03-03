import * as vscode from 'vscode';

const DEBUG_SETTING_KEY = 'olla-chat.debugLogs';
const CHANNEL_NAME = 'Olla Chat Debug';
const PAYLOAD_LIMIT = 1600;

let outputChannel: vscode.OutputChannel | undefined;
let enabled = false;
let initialized = false;

export function initializeDebugLogger(context: vscode.ExtensionContext): void {
    if (initialized) {
        return;
    }
    initialized = true;
    outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
    context.subscriptions.push(outputChannel);

    enabled = vscode.workspace.getConfiguration('olla-chat').get<boolean>('debugLogs', false);
    if (enabled) {
        outputChannel.show(true);
        writeRaw('Logger enabled');
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(DEBUG_SETTING_KEY)) {
                return;
            }
            enabled = vscode.workspace.getConfiguration('olla-chat').get<boolean>('debugLogs', false);
            if (enabled) {
                outputChannel?.show(true);
            }
            writeRaw(`Debug logging ${enabled ? 'enabled' : 'disabled'}`);
        })
    );
}

export function showDebugLogger(): void {
    outputChannel?.show(true);
}

export function isDebugLoggingEnabled(): boolean {
    if (!initialized) {
        return vscode.workspace.getConfiguration('olla-chat').get<boolean>('debugLogs', false);
    }
    return enabled;
}

export function debugLog(scope: string, message: string, details?: unknown): void {
    if (!isDebugLoggingEnabled()) {
        return;
    }
    const prefix = `[${new Date().toISOString()}] [${scope}] ${message}`;
    if (details === undefined) {
        writeRaw(prefix);
        return;
    }
    writeRaw(`${prefix} ${safeSerialize(details)}`);
}

export function debugError(scope: string, message: string, error: unknown, details?: unknown): void {
    if (!isDebugLoggingEnabled()) {
        return;
    }
    const errorMessage = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const payload = details === undefined
        ? { error: errorMessage }
        : { error: errorMessage, details };
    writeRaw(`[${new Date().toISOString()}] [${scope}] ${message} ${safeSerialize(payload)}`);
}

function writeRaw(line: string): void {
    outputChannel?.appendLine(line);
}

function safeSerialize(value: unknown): string {
    try {
        const seen = new WeakSet<object>();
        const raw = JSON.stringify(
            value,
            (_key, entry: unknown) => {
                if (typeof entry === 'object' && entry !== null) {
                    if (seen.has(entry as object)) {
                        return '[Circular]';
                    }
                    seen.add(entry as object);
                }
                return entry;
            }
        );
        if (!raw) {
            return '';
        }
        return raw.length > PAYLOAD_LIMIT
            ? `${raw.slice(0, PAYLOAD_LIMIT)}…(truncated ${raw.length - PAYLOAD_LIMIT} chars)`
            : raw;
    } catch {
        return '[Unserializable payload]';
    }
}
