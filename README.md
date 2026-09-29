# pi-dynamic-topic

A Pi extension that turns the first message of a session into two things at once: a **topic** (synced to your terminal title and Herdr tab) and a **capability route** (which tools and skills stay active for the rest of the session).

## How it works

1. **Cold start** — only `baseTools` are active. Skills are hidden from the system prompt.
2. **First message** — a short routing instruction is appended to the **system prompt** (that turn only), listing the tools and skills that are not active yet. Your own message is never rewritten, and the instruction vanishes as soon as routing lands, so it cannot nudge later turns.
3. **Model replies** — it ends with a `<topic>` block naming a title, description, mode, and the tools/skills it actually needs. A *trailing* block is stripped before rendering; blocks quoted mid-answer (e.g. inside code fences) are left alone.
4. **Rest of the session** — the chosen tools are activated on top of `baseTools`, and only the chosen skills appear in the system prompt. Skill bodies are never injected; the kept `<skill>` entries carry their `<location>` and the model reads them on demand, as in plain Pi.
5. **After compaction** — step 2 repeats, so the topic and route follow what the session has become.

If the model omits the `<topic>` block, the instruction is retried once on the next turn. If it is omitted again, all tools and skills are released — the session degrades to plain Pi rather than silently losing capabilities. Sessions that predate the plugin get a title only; their tools and skills are left untouched.

The skill pool comes from the `<available_skills>` block Pi puts in the system prompt, so it always matches what Pi actually loaded (settings paths, packages, `resources_discover`).

## Install

```bash
pi install git:github.com/paprays/pi-dynamic-topic
```

## Commands

### `/topic` — session topic

```text
/topic                          # show current topic, mode, active tools & skills
/topic FastSort - 快排优化       # override the topic manually
/topic update                   # next turn: let the model re-route (adds to what is active)
/topic update 新主题 - 描述 --mode ppt --tools +generate_image,-nu --skills deep-research,-ponytail
```

`/topic update` with arguments applies in place. Every part is optional and omitted parts keep
their current value. In `--tools` / `--skills`, `name` or `+name` adds and `-name` removes.

### `/mode` — capability modes

```text
/mode                                    # list modes (same as /mode list)
/mode code                               # switch: activate that mode's tools & skills
/mode add rev 逆向分析 --tools gdb-mcp_open,ast_search --skills ponytail
/mode edit rev 新描述 --tools nu          # omitted fields keep their current value
/mode del rev
/mode init [--project]                   # scan the environment and (re)generate all modes
```

`--tools` / `--skills` take a comma-separated list with no spaces (`-t` / `-s` for short).
Use `--desc` (`-d`) with quotes if the description itself contains flags.

`/mode init` asks the current model to sort every installed tool and skill into modes, falling
back to a name-based heuristic if the model is unavailable. `--project` writes the result next to
the project instead of globally.

## Configuration

Project-level wins over global:

| Scope | Path |
|---|---|
| Project | `<cwd>/.pi/extension-settings/dynamic-topic.json` |
| Global | `$PI_CODING_AGENT_DIR/extension-settings/dynamic-topic.json` (default `~/.pi/agent/…`) |

```jsonc
{
  "version": 1,
  "baseTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "modes": {
    "code": {
      "description": "编程开发、代码分析、排错与底层调试",
      "recommendedTools": ["gdb-mcp_open", "lsp_diagnostics", "ast_search"],
      "recommendedSkills": ["ponytail"]
    }
  },
  "customToolAliases": { "gdb": "gdb-mcp_open", "lsp": "lsp_diagnostics" }
}
```

Missing or malformed fields fall back to the built-in defaults, so a hand-edited file can't break
the session. Writes back up the previous file to `dynamic-topic.json.bak`.

Tool names are resolved by exact match, then by alias, then by prefix/suffix (`ast` → `ast_search`).
Names that match nothing are dropped rather than guessed at.

## Development

```bash
node test_e2e.js                # unit + command tests, no framework — requires Node >= 22.18
node test_routing_lifecycle.js  # first turn / compact / resume / retry / /topic update
```

## License

MIT
