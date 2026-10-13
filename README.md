# pi-auto-drive

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that drives your session for you. After the agent finishes each run, a second model plays the human and sends the next instruction.

## Quick start

Install the extension:

```bash
pi install https://github.com/eleqtrizit/pi-auto-drive
```

Then set a driver model and start auto-drive:

```text
/set-auto-drive-model-global <provider/model>
/auto-drive-on
```

## How it works

1. When the agent run settles (`agent_settled`), the extension reads the active session context (compaction-aware).
2. It builds an in-memory copy with user and assistant roles swapped. Only text is kept, plus one-line tool markers such as `[tool: bash {"command":"npm test"}]`. Thinking, tool results, and images are dropped.
3. It queries the driver model on the side. The query never enters your session.
4. The driver reply is sent as the next user message. When the driver replies `AUTO_DRIVE_DONE`, auto-drive stops.

## Commands

| Command | Effect |
|---------|--------|
| `/auto-drive-on` | Start auto-drive. Shows the model, the turn cap, and how to stop. |
| `/auto-drive-off` | Stop auto-drive. |
| `/set-auto-drive-model-global <provider/model>` | Set the driver model for all repos. |
| `/set-auto-drive-model-repo <provider/model>` | Set the driver model for this repo. Overrides the global model. |
| `/set-auto-drive-cap <n>` | Set the maximum driven turns per `/auto-drive-on`. Default: 50. |

Auto-drive stops when the driver reports the goal is met, when the cap is reached, or when the driver call fails. Typed input does not stop it: your message runs, and the driver takes over after it.

## Configuration files

- Global: `~/.pi/agent/pi-auto-drive.json` (`model`, `cap`)
- Repo: `<repo>/.pi/pi-auto-drive.json` (`model`)

## Development

```bash
npm install
npm run typecheck
npm test
pi -e ./extensions/index.ts
```
