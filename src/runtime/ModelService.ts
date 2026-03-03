import * as vscode from 'vscode';
import { ChatOllama } from '@langchain/ollama';
import { ModelCapability } from '../types/protocol';
import { debugError, debugLog } from './DebugLogger';

export class ModelService {
    public getConfiguredModel(): string {
        const config = vscode.workspace.getConfiguration('olla-chat');
        return config.get<string>('ollamaModel', 'llama3');
    }

    public async setConfiguredModel(model: string): Promise<void> {
        debugLog('ModelService', 'Updating configured model', { model });
        await vscode.workspace.getConfiguration('olla-chat').update('ollamaModel', model, vscode.ConfigurationTarget.Global);
    }

    public getConfiguredTemperature(): number {
        const config = vscode.workspace.getConfiguration('olla-chat');
        const value = config.get<number>('temperature', 0.1);
        return Number.isFinite(value) ? clampTemperature(value) : 0.1;
    }

    public async setConfiguredTemperature(temperature: number): Promise<void> {
        debugLog('ModelService', 'Updating configured temperature', { temperature: clampTemperature(temperature) });
        await vscode.workspace.getConfiguration('olla-chat').update(
            'temperature',
            clampTemperature(temperature),
            vscode.ConfigurationTarget.Global
        );
    }

    public getBaseUrl(): string {
        const config = vscode.workspace.getConfiguration('olla-chat');
        return config.get<string>('ollamaUrl', 'http://localhost:11434');
    }

    public async listModels(): Promise<ModelCapability[]> {
        const url = `${this.getBaseUrl()}/api/tags`;
        debugLog('ModelService', 'Listing models', { url });
        try {
            const response = await fetch(url);
            if (!response.ok) {
                debugLog('ModelService', 'Model listing failed with non-OK response', { status: response.status });
                return [];
            }

            const data = await response.json() as { models?: Array<{ name?: string }> };
            const models = data.models ?? [];
            return models
                .map((model) => model.name ?? '')
                .filter((name) => name.length > 0)
                .map((name) => this.withCapabilities(name));
        } catch (error) {
            console.error('Unable to list Ollama models:', error);
            debugError('ModelService', 'Model listing failed', error, { url });
            return [];
        }
    }

    public createChatModel(model: string, temperature?: number) {
        const resolvedTemperature = clampTemperature(temperature ?? this.getConfiguredTemperature());
        debugLog('ModelService', 'Creating chat model', {
            model,
            baseUrl: this.getBaseUrl(),
            temperature: resolvedTemperature
        });
        return new ChatOllama({
            baseUrl: this.getBaseUrl(),
            model,
            temperature: resolvedTemperature
        });
    }

    public withCapabilities(name: string): ModelCapability {
        const lowered = name.toLowerCase();
        const toolCalling = /(llama3|qwen2\.5|qwen3|mistral|deepseek|command-r|phi4)/.test(lowered);
        const vision = /(llava|vision|qwen2\.5vl|qwen3-vl|qwen-vl|minicpm-v|moondream|gemma3)/.test(lowered);
        return { name, toolCalling, vision };
    }
}

function clampTemperature(value: number): number {
    return Math.max(0, Math.min(2, Math.round(value * 10) / 10));
}
