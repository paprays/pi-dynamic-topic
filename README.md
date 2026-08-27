# pi-dynamic-topic

A Pi extension that dynamically generates concise conversation topics on session startup and after compaction, automatically synchronizing them to your terminal title (OSC 0/2) and Herdr tabs.

## Features

- **Lean & Targeted**: Topic extraction instructions are injected strictly on the first user prompt and immediately after compaction, leaving regular turns clean.
- **Terminal & Herdr Sync**: Automatically updates terminal title (via OSC escape codes) and syncs Herdr tab label when running in a Herdr environment.
- **Zero-Pollution Output**: Assistant responses are sanitized to strip internal `<topic>` tags before rendering.
- **State Locked**: Uses a single-turn expectation lock to prevent false-positive topic parsing during regular code discussion.
- **Manual Command**: Inspect or override topic at any time via `/topic [name]`.

## Install

```bash
pi install git:github.com/paprays/pi-dynamic-topic
```

## Usage

Once installed, the extension works automatically in the background:

- **On session start**: First question sets initial topic and title.
- **On compaction**: Next question automatically re-summarizes current focus.
- **Manual override**:
  ```text
  /topic
  /topic FastSort - QuickSort Optimization
  ```

## License

MIT
