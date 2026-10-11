# claude-mods

Mods for [Claude Code](https://claude.com/claude-code), published as a plugin marketplace.

| Mod | What it does |
| --- | --- |
| `sidebar` | Live sidebar: model badge, context-window gauge, session cost, 5-hour / weekly usage dial, and the buttons below. Installing it also installs `commit-push` and `handoff`. |
| `commit-push` | **⇡ Commit & Push** button and `/commit-push`. Stages everything, has Claude write a conventional-commit message from the diff, commits, and pushes (setting the upstream if there is none). |
| `handoff` | **⇄ Handoff** button and `/handoff`. Has Claude write `handoff.md`, then runs `/clear` and has the fresh chat read it and carry on. |

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

## Notes

- Works on Windows, macOS and Linux. `commit-push` only needs `git` on your PATH.
- **Commit & Push** stages everything (`git add -A`) in the session's current folder and sends the staged diff to Claude (Haiku) to write the message. It never force-pushes. It stops and tells you instead of pushing when the branch is behind its upstream, there are unresolved conflicts, a merge/rebase is in progress, or HEAD is detached. Push errors (network, auth, rejected) are shown with git's own error text.
- **Handoff** sends a fixed prompt asking Claude to write `handoff.md` in the project root, waits until the file exists, runs `/clear`, then tells the new chat to read it and continue. Edit the prompt in `mods/handoff/hooks/register.tsx`.
- `sidebar` has one optional setting, `budgetUsd` (default 5): the dollar figure the cost bar fills against.
