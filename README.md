# pi-dynamic-topic

Dynamic conversation topic generator & window/tab title synchronizer extension for [pi-coding-agent](https://github.com/earendil-works/pi-mono).

Automatically extracts concise session topics `[title - description]` via structured XML tags from AI responses (first turn and compact phases), updating both terminal window titles (OSC 0/2) and [Herdr](https://herdr.dev) workspace tab labels in real-time.

---

## Features

- **Structured XML Generation**: Injects system instructions during first-turn and `/compact` summarization phases to generate structured `<topic><title>...</title><description>...</description></topic>` tags.
- **Zero-False-Positive Extraction**: Safely parses the structured XML block and strips it cleanly from the assistant output so that your conversation UI stays clean.
- **Instant Fallback**: Updates terminal title instantly on user prompt via lightweight heuristics, then seamlessly upgrades to the AI-generated semantic topic.
- **Multi-Environment Sync**:
  - Sets standard terminal window/tab title via ANSI OSC `\x1b]0;...\x07`.
  - Automatically syncs with **Herdr** tab labels via local IPC Unix socket when running inside Herdr.
- **Manual Override**: Provides `/topic [title - description]` command to view or manually override the session topic.

---

## Installation

Place `index.ts` into your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/payprays/pi-dynamic-topic/main/index.ts -o ~/.pi/agent/extensions/dynamic-topic.ts
```

Or clone this repository directly:

```bash
git clone https://github.com/payprays/pi-dynamic-topic.git ~/.pi/agent/extensions/dynamic-topic
```

Reload extensions inside an active Pi session with `/reload`.

---

## Usage & Commands

### 1. Automatic Naming
Just start typing! On the first prompt and response:
- Pi updates the terminal and Herdr tab title to `[短标题 - 具体任务描述]`.
- When `/compact` is executed, the topic updates to reflect the latest state.

### 2. Manual Command
```text
/topic                          # View current topic
/topic Kitty键位 - 检查捕获状态     # Manually set topic
```

---

## License

MIT
