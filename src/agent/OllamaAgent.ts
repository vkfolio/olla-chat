import { ChatOllama } from "@langchain/community/chat_models/ollama";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import * as vscode from 'vscode';

export class OllamaAgent {
    private chatModel: ChatOllama;
    private messages: any[] = [];

    constructor() {
        this.chatModel = new ChatOllama({
            baseUrl: "http://localhost:11434",
            model: "llama3",
            temperature: 0.1,
        });

        this.messages.push(new SystemMessage("You are a professional AI coding assistant running inside VS Code. You can help the user write code, understand errors, and eventually execute tools."));
    }

    private getEditorContext(): string {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return "";

        const document = editor.document;
        const selection = editor.selection;
        const fileName = document.fileName;

        let contextBlock = `\n\n--- Context: The user is currently editing ${fileName} ---\n`;

        if (!selection.isEmpty) {
            const selectedText = document.getText(selection);
            contextBlock += `User's current selected text:\n\`\`\`\n${selectedText}\n\`\`\`\n`;
        } else {
            // Keep it brief if the file is massive to save tokens
            const visibleText = document.getText().substring(0, 2000);
            contextBlock += `File content (truncated):\n\`\`\`\n${visibleText}\n\`\`\`\n`;
        }

        return contextBlock;
    }

    public async sendMessage(
        userText: string,
        onChunk: (chunk: string) => void,
        onThinkingChanged: (isThinking: boolean) => void
    ) {
        const context = this.getEditorContext();
        this.messages.push(new HumanMessage(userText + context));


        try {
            // Stream the response so the Webview feels fast and professional
            const stream = await this.chatModel.stream(this.messages);
            let fullResponse = "";
            let insideThinkBlock = false;

            for await (const chunk of stream) {
                const text = chunk.content as string;
                fullResponse += text;

                // Very basic detection of <think> tags for DeepSeek models
                if (text.includes("<think>")) {
                    insideThinkBlock = true;
                    onThinkingChanged(true);
                }
                if (text.includes("</think>")) {
                    insideThinkBlock = false;
                    onThinkingChanged(false);
                }

                onChunk(text);
            }

            this.messages.push(new AIMessage(fullResponse));
        } catch (error: any) {
            onChunk(`\n\n**Error:** Could not connect to Ollama. Make sure it is running locally.\n${error.message}`);
        }
    }
}
