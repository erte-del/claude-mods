# claude-mods

<img width="391" height="379" alt="image" src="https://github.com/user-attachments/assets/6a3cb2d9-57cb-47e2-84c0-6cfc547499c3" />



Small mods for [Claude Code](https://claude.com/claude-code): a live sidebar with one-click buttons for the things you do every session, and a repo picker. Works on Windows, macOS and Linux.

| Mod | What you get |
| --- | --- |
| **sidebar** | Model badge, context-window gauge, session cost, a 5-hour / weekly usage dial, and buttons for **New chat**, **Commit & Push** and **Handoff** |
| **commit-push** | One click to stage, commit (with a Claude-written message) and push |
| **handoff** | One click to save a `handoff.md`, clear the chat, and continue from it |
| **repo** | Pick a GitHub repo, clone it if needed, and move the session into it |
| **restart-ultron-backend** | A Restart backend button in a sidebar pane, active only in the `ULTRON_cBrain` folder |

## Install

In Claude Code:

```
/plugin marketplace add erte-del/claude-mods
/plugin install sidebar@claude-mods
/plugin install repo@claude-mods
/reload-plugins
```

Or from a terminal:

```
claude plugin marketplace add erte-del/claude-mods
claude plugin install sidebar@claude-mods --scope user
claude plugin install repo@claude-mods --scope user
```

Installing `sidebar` also installs `commit-push` and `handoff`, because its buttons call them. `repo` is separate, since it opens a picker when a session starts; skip it if you don't want that.

Start a new session or run `/reload-plugins` and the sidebar appears. It docks beside the transcript on terminals 110 columns or wider, and otherwise shows as a bar above the prompt.

**Requirements:** Claude Code and `git`. `repo` also uses the GitHub CLI (`gh`, signed in with `gh auth login`) to list your repos.

## What each mod does

### sidebar

Live status, redrawn after every turn:

- the current model
- how full the context window is
- what the session has cost so far
- how much of your 5-hour and weekly limits you've used, as a dial, with time until each resets

Buttons, top to bottom: **＋ New chat** runs `/clear`. **⇡ Commit & Push** and **⇄ Handoff** run the mods below. **↻ Reload plugins** runs `/reload-plugins`.

### commit-push

Click **⇡ Commit & Push**, or type `/commit-push`.

1. Checks the current repo. If nothing changed, it says so and stops.
2. Stages everything (`git add -A`).
3. Sends the staged diff to Claude (Haiku) for a one-line conventional-commit message such as `fix: handle empty repo list in picker`. If that fails it falls back to naming the changed files.
4. Commits, then pushes. If the branch has no upstream yet, it runs `git push -u origin <branch>`.
5. Shows the commit message and the result in the sidebar. A failed push shows git's own error text plus a hint (network, sign-in, rejected, protected branch).

It never force-pushes. It stops and leaves it to you when the branch is behind its upstream, there are unresolved merge conflicts, a merge or rebase is in progress, or HEAD is detached. Your files are only staged when it gets as far as committing.

It works on whatever folder the session is in, so it follows `repo`.

### handoff

Click **⇄ Handoff**, or type `/handoff`. Use it when your context is getting full.

1. Asks Claude to write `handoff.md` in the project root: what you're doing, current state, the exact next step, decisions made, gotchas and open questions. An existing `handoff.md` is overwritten.
2. Waits for the turn to finish and the file to appear.
3. Runs `/clear`.
4. Tells the fresh chat to read `handoff.md` and carry on from its next step.

If you interrupt, the turn errors, or Claude finishes without writing the file, it stops without clearing anything. The prompt is in [`mods/handoff/hooks/register.tsx`](mods/handoff/hooks/register.tsx) if you want to change what goes in the file.

### repo

Opens a picker when a session starts with no repo chosen, or type `/repo`.

- Type part of a name to fuzzy-search your repos (matches on name, then description), `list` to see them all, then a number to pick.
- Or type a full name, `owner/repo`, or a git URL.
- It looks for an existing checkout in the usual places (`~/repos`, `~/Documents`, `~/Desktop`, `~/code`, `~/projects`, `~/dev`, `~/src`, `~/GitHub` and a few more) and clones the repo if it can't find one.
- Then it moves the session into that folder and tells Claude which repo is active.

## Settings

Change these in `/config` (each mod's settings are listed under its name).

| Mod | Setting | Default | What it does |
| --- | --- | --- | --- |
| sidebar | `budgetUsd` | `5` | The session cost that fills the cost bar |
| sidebar | `ascii` | off | Draw bars with `#` and `-` and skip the dial, for terminals that can't show block characters |
| repo | `owner` | your `gh` login | Whose repos to list: another user or an organization |
| repo | `cloneDir` | `~/repos` | Where missing repos are cloned |
| repo | `openOnStart` | on | Open the picker when a session starts with no active repo |

## Updating and removing

```
claude plugin marketplace update claude-mods
claude plugin uninstall sidebar@claude-mods
```

Each mod lives in its own folder under [`mods/`](mods/) with its tests next to the code (`claude plugin test mods/<name>`).
