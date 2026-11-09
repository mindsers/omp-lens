# Changelog

## 0.1.0

First public release.

- `/lens` file browser with a syntax-highlighted preview, rendered Markdown, indented JSON and image sizes.
- `/lens <path>`, `/lens find`, `/lens grep` and `/lens changes` open straight into a folder or mode.
- Git markers, changed-only filter and diff against HEAD.
- `@path` and `@path#L12-20` references inserted into the prompt.
- Edit in `$VISUAL` / `$EDITOR`; the diff of your edit is queued for the agent's next turn.
- Review of the agent's changes per turn or per session, with its diff.
