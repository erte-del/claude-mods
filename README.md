# claude-mods

Mods for [Claude Code](https://claude.com/claude-code), published as a plugin marketplace.

| Mod | What it does |
| --- | --- |
| `sidebar` | Live sidebar: model badge, context-window gauge, session cost, 5-hour / weekly usage dial, reload button. |

## Install

In Claude Code:

```
/plugin marketplace add erte-del/claude-mods
/plugin install sidebar@claude-mods
/reload-plugins
```

Or from any terminal:

```
claude plugin marketplace add erte-del/claude-mods
claude plugin install sidebar@claude-mods --scope user
```

Then run `/reload-plugins` in Claude Code (or start a new session). The sidebar opens by itself on session start; it docks beside the transcript on wide terminals (110+ columns) and otherwise shows as a bar above the prompt.

Update later with `claude plugin marketplace update claude-mods`.

## Options

`sidebar` reads one optional setting, `budgetUsd` (default 5): the dollar figure the cost bar fills against.
