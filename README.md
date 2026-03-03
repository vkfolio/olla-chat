# Olla Chat

Professional AI assistant sidebar for VS Code with an Ollama-first workflow. It supports `Ask`, `Plan`, and `Agent` modes, streaming responses, editable approvals, file/image attachments, and selection-aware edits.

## Features

- Multi-session chat with mode switching (`Ask`, `Plan`, `Agent`)
- Ollama model selection and temperature control
- Selection/file/project-aware context controls
- Streaming assistant output and timeline events
- Human-in-the-loop approvals for risky actions
- Apply/undo selection replacement flow
- Vision attachments with compatible models
- VS Code theme-aware UI

## Requirements

- VS Code `>= 1.85.0`
- Ollama server running (default: `http://localhost:11434`)
- At least one installed model (`ollama list`)

## Configuration

Key settings (prefix `olla-chat.*`):

- `ollamaUrl`: Ollama base URL
- `ollamaModel`: default model name
- `temperature`: generation temperature
- `defaultMode`: `ask | plan | agent`
- `approvalPolicy`: `human_gated | auto_safe`
- `contextPolicy`: `auto_light | manual_only | always_project`
- `debugLogs`: enables verbose Output channel logs

## Development

From repository root:

```bash
npm install
npm run compile
```

Build webview UI:

```bash
npm --prefix webview-ui install
npm run build:webview
```

Run extension locally: press `F5` in VS Code (`Run Extension`).

## Packaging

Build production artifacts and VSIX:

```bash
npm run build:all
npm run package:vsix
```

Output file: `olla-chat.vsix` (repository root).

Install locally for validation:

```bash
code --install-extension olla-chat.vsix
```

## Marketplace Assets

Extension listing icon requirements:

- Format: PNG
- Size: **128 x 128 px** (required minimum)
- Recommended source design: 256 x 256, exported to 128 x 128

Current placeholder icon is at `media/icon.png`. Replace it before publishing.

Activity bar icon is at `media/view-icon.svg`.

## Publish Checklist

- Update `publisher` in `package.json` to your real VS Marketplace publisher ID.
- Set a release version in `package.json`.
- Replace placeholder icon and verify in light/dark themes.
- Run:
  - `npm run build:all`
  - `npm run package:vsix`
- Publish with VSCE:

```bash
npx @vscode/vsce publish
```
