# Repository Guidelines

## Project Structure & Module Organization
This repository is a VS Code extension with a bundled React webview.

- `src/`: Extension host TypeScript. Entry point is `src/extension.ts`; sidebar wiring is in `src/ChatWebviewProvider.ts`; model/tool logic is in `src/agent/OllamaAgent.ts`.
- `webview-ui/`: React + Vite frontend rendered inside the extension webview (`webview-ui/src`, static files in `webview-ui/public`).
- Build outputs: `dist/` (extension bundle via webpack), `webview-ui/build/` (webview assets via Vite), and `out/` (TypeScript output used by tooling).
- Editor/run config: `.vscode/launch.json` and `.vscode/tasks.json`.

## Build, Test, and Development Commands
Run commands from the repository root unless noted.

- `npm install`: Install extension dependencies.
- `npm run compile`: Build extension code to `dist/`.
- `npm run watch`: Rebuild extension on file changes.
- `npm run package`: Production webpack bundle for publishing.
- `cd webview-ui && npm install`: Install frontend dependencies.
- `cd webview-ui && npm run dev`: Run Vite dev server for UI work.
- `cd webview-ui && npm run build`: Produce webview assets in `webview-ui/build`.
- `cd webview-ui && npm run lint`: Run ESLint for TS/React files.

Use VS Code `Run Extension` (F5) for end-to-end local validation.

## Coding Style & Naming Conventions
- TypeScript strict mode is enabled in both extension and webview configs; keep code type-safe.
- Match local style per package:
  - `src/`: 4-space indentation, semicolons, explicit typing where helpful.
  - `webview-ui/src/`: 2-space indentation, semicolon-light React/Vite style.
- Naming: `PascalCase` for classes/components, `camelCase` for variables/functions, descriptive command/config IDs (for example, `olla-chat.focus`, `olla-chat.ollamaModel`).

## Testing Guidelines
No automated test suite is configured yet. Minimum pre-PR checks:

- `npm run compile`
- `cd webview-ui && npm run lint && npm run build`
- Manual smoke test in Extension Development Host: open sidebar, load models, send a prompt, verify streamed response and settings actions.

When adding tests, prefer colocated files named `*.test.ts` or `*.test.tsx`.

## Commit & Pull Request Guidelines
Current history is minimal (`init`), so use clear imperative commit subjects (example: `Add model refresh action`).

- Keep commits focused and logically scoped.
- PRs should include: what changed, why, validation commands, and screenshots/GIFs for UI changes.
- Link related issues/tasks and call out any config changes affecting `olla-chat.*` settings.

## Security & Configuration Tips
`OllamaAgent` can execute local shell commands through tool calls. Keep defaults pointed at trusted local Ollama endpoints and review model/tool behavior before enabling broad use.
