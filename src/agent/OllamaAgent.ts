import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';

// --- Define VS Code Tools via raw JSON Schema to avoid deep TS errors with Zod ---

const toolSchemas = [
    {
        name: "read_file",
        description: "Read the contents of a file on the local filesystem.",
        schema: {
            type: "object",
            properties: {
                path: { type: "string", description: "The absolute path to the file to read." }
            },
            required: ["path"]
        }
    },
    {
        name: "execute_command",
        description: "Run a terminal command in the current VS Code workspace. Use this to run tests, build, or analyze.",
        schema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to execute." }
            },
            required: ["command"]
        }
    }
];

// Local functions map for execution
const toolExecutors: Record<string, (args: any) => Promise<string>> = {
    "read_file": async ({ path }) => {
        try {
            const content = fs.readFileSync(path, 'utf-8');
            return content.substring(0, 5000); // Limit context size
        } catch (e: any) {
            return `Error reading file: ${e.message}`;
        }
    },
    "execute_command": async ({ command }) => {
        return new Promise((resolve) => {
            cp.exec(command, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || __dirname }, (error, stdout, stderr) => {
                if (error) {
                    resolve(`Error: ${error.message}\nStderr: ${stderr}`);
                } else {
                    resolve(stdout || "Command executed successfully with no output.");
                }
            });
        });
    }
};

export class OllamaAgent {
    private chatModel: any;
    private messages: BaseMessage[] = [];

    constructor() {
        const baseModel = new ChatOllama({
            baseUrl: "http://localhost:11434",
            model: "llama3", // User will need to use a model that supports tools, e.g. llama3.1
            temperature: 0.1,
        });

        // Bind the JSON schemas to the LLM
        this.chatModel = (baseModel as any).bindTools(toolSchemas);

        this.messages.push(new SystemMessage(
            "You are a professional AI coding assistant running inside VS Code. " +
            "You have access to tools to read files and run terminal commands. " +
            "If a user asks you to do something that requires knowing the codebase, USE YOUR TOOLS first."
        ));
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
            const visibleText = document.getText().substring(0, 2000);
            contextBlock += `File content (truncated):\n\`\`\`\n${visibleText}\n\`\`\`\n`;
        }

        return contextBlock;
    }

    public async sendMessage(
        userText: string,
        onChunk: (chunk: string) => void,
        onThinkingChanged: (isThinking: boolean, statusText?: string) => void
    ) {
        const context = this.getEditorContext();
        this.messages.push(new HumanMessage(userText + context));

        await this.runExecutionLoop(onChunk, onThinkingChanged);
    }

    private async runExecutionLoop(
        onChunk: (chunk: string) => void,
        onThinkingChanged: (isThinking: boolean, statusText?: string) => void
    ) {
        try {
            // Stream the response so the Webview feels fast and professional
            const stream = await this.chatModel.stream(this.messages);
            let fullResponse = "";
            let toolCalls: any[] = [];
            let insideThinkBlock = false;

            for await (const chunk of stream) {
                // If it's pure text, stream it to the Webview
                if (chunk.content) {
                    const text = chunk.content as string;
                    fullResponse += text;

                    if (text.includes("<think>")) {
                        insideThinkBlock = true;
                        onThinkingChanged(true, "Thinking...");
                    }
                    if (text.includes("</think>")) {
                        insideThinkBlock = false;
                        onThinkingChanged(false);
                    }

                    onChunk(text);
                }

                // If the LLM is accumulating tool calls
                if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                    chunk.tool_calls.forEach((tc: any) => {
                        toolCalls.push(tc);
                    });
                }
            }

            // Save the LLM's message (which might contain tool calls)
            // @ts-ignore - bypassing strict TS checks for the dynamic message construction
            const aiMsg = new AIMessage({ content: fullResponse, tool_calls: toolCalls });
            this.messages.push(aiMsg);

            // If the LLM didn't call any tools, we are completely done.
            if (toolCalls.length === 0) {
                return;
            }

            // --- TOOL EXECUTION PHASE ---

            for (const toolCall of toolCalls) {
                // 1. Notify the UI we are taking action
                onThinkingChanged(true, `Executing: ${toolCall.name}...`);

                // 2. Find the local function
                const executor = toolExecutors[toolCall.name];
                if (!executor) continue;

                // 3. Execute it and capture result
                const result = await executor(toolCall.args);

                // 4. Append the tool result to the message history so the LLM sees it
                this.messages.push(new ToolMessage({
                    tool_call_id: toolCall.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result)
                }));
            }

            // 5. Turn off the "Thinking" UI
            onThinkingChanged(false);

            // 6. Recurse! Ask the LLM to process the tool results and continue
            onChunk("\n\n"); // Add some spacing in the UI before the tool result processing
            await this.runExecutionLoop(onChunk, onThinkingChanged);

        } catch (error: any) {
            onThinkingChanged(false);
            onChunk(`\n\n**Error:** Could not communicate with model. Make sure you are using a tool-compatible model like llama3.1 or qwen2.5. \n${error.message}`);
        }
    }
}
