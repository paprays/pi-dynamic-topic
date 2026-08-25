# pi-dynamic-topic

Dynamic conversation topic generator & window/tab title synchronizer extension for [pi-coding-agent](https://github.com/earendil-works/pi-mono).

Automatically extracts concise session topics `[title - description]` via structured XML tags from AI responses (strictly during the first turn and compact phases), updating both terminal window titles (OSC 0/2) and [Herdr](https://herdr.dev) workspace tab labels in real-time.

---

## Features

- **Strict Lifecycle Injection**: Only injects topic instructions on the very **first conversation turn** and during `/compact` summaries. Subsequent ordinary conversation turns are never polluted.
- **Structured XML Extraction**: Uses `<topic><title>...</title><description>...</description></topic>` tags for zero-false-positive recognition.
- **Silent Tag Stripping**: Seamlessly removes `<topic>` tags from assistant messages, keeping UI transcripts clean.
- **Session Persistence**: Stores the generated topic in custom Session metadata (`dynamic-topic-state`) to survive restarts and reloads without re-injecting.
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

## License

MIT
