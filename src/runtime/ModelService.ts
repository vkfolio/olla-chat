import * as vscode from 'vscode';
import { ChatOllama } from '@langchain/ollama';
import { ModelCapability } from '../types/protocol';

export class ModelService {
    public getConfiguredModel(): string {
        const config = vscode.workspace.getConfiguration('olla-chat');
        return config.get<string>('ollamaModel', 'llama3');
    }

    public async setConfiguredModel(model: string): Promise<void> {
        await vscode.workspace.getConfiguration('olla-chat').update('ollamaModel', model, vscode.ConfigurationTarget.Global);
    }

    public getBaseUrl(): string {
        const config = vscode.workspace.getConfiguration('olla-chat');
        return config.get<string>('ollamaUrl', 'http://localhost:11434');
    }

    public async listModels(): Promise<ModelCapability[]> {
        try {
            const response = await fetch(`${this.getBaseUrl()}/api/tags`);
            if (!response.ok) {
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
            return [];
        }
    }

    public createChatModel(model: string) {
        return new ChatOllama({
            baseUrl: this.getBaseUrl(),
            model,
            temperature: 0.1
        });
    }

    public withCapabilities(name: string): ModelCapability {
        const lowered = name.toLowerCase();
        const toolCalling = /(llama3|qwen2\.5|qwen3|mistral|deepseek|command-r|phi4)/.test(lowered);
        const vision = /(llava|vision|qwen2\.5vl|qwen-vl|minicpm-v|moondream|gemma3)/.test(lowered);
        return { name, toolCalling, vision };
    }
}
