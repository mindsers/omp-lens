# Changelog

## 0.1.0

First public release.

- `/lens` file browser with a syntax-highlighted preview, rendered Markdown, indented JSON and image sizes.
- `/lens <path>`, `/lens find`, `/lens grep` and `/lens changes` open straight into a folder or mode.
- Git markers, changed-only filter and diff against HEAD.
- `@path` and `@path#L12-20` references inserted into the prompt.
- Edit in `$VISUAL` / `$EDITOR`; the diff of your edit is queued for the agent's next turn.
- Review of the agent's changes per turn or per session, with its diff.
- Agent-change tracking follows the session across `/new`, `/resume`, `/fork` and session-tree moves.
- Untrusted text is drawn terminal-safe; git runs without fsmonitor, filter, external diff or textconv programs,
  stays out of submodules, and runs nothing in a repository whose config cannot be read.
- Failures (a search, a diff, git status, agent tracking) are shown, never passed off as empty results.
