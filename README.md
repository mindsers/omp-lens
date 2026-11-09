# omp-lens

[![CI](https://github.com/mindsers/omp-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/mindsers/omp-lens/actions/workflows/ci.yml)

A file browser for [omp](https://github.com/can1357/oh-my-pi). Type `/lens` to browse your project, preview
files with syntax highlighting, hand files or exact line ranges to the agent, search the repo, review what the
agent changed, and edit in your own editor — with the agent told what you changed.

Tested with omp 18.16.0 on macOS; the extension API it uses was checked against 18.17.0.

## Install

```sh
omp plugin install github:mindsers/omp-lens    # from git
omp plugin install omp-lens                     # from npm, once published
omp plugin link /path/to/omp-lens               # a local checkout, for development
```

Then restart omp (extensions load at startup) and run `/lens`.

## Command

| Command | Opens |
|---|---|
| `/lens` | The browser, in the working directory |
| `/lens <path>` | At a folder, or at a file's folder with the file selected (`~/` works) |
| `/lens find [query]` | Find files by name, the query already typed |
| `/lens grep [query]` | Search file contents; with a query, the results are shown straight away |
| `/lens changes [session]` | Only the files the agent changed in its last turn (or the whole session), with its diff |

Subcommands complete with Tab. To open a folder named like a subcommand, write `./find`.

## What it does

- **Browse** folders with a preview pane: syntax-highlighted source, rendered Markdown, indented JSON, image
  size, directory contents. On narrow terminals the preview moves below the list; on tiny ones it is hidden.
- **Git aware**: `M A D R ?` markers on files, `*` on folders that contain changes, a changed-only filter, and
  the diff against HEAD.
- **Hand context to the agent**: insert `@path` for a file or marked files, or `@path#L12-20` for a line range
  chosen in the preview.
- **Edit in your editor** (`$VISUAL` / `$EDITOR`, default `vi`), opened at the line you were looking at. When you
  quit, the plugin diffs the working tree against a snapshot taken before and queues the diff for the agent's
  next turn. It never starts a turn on its own.
- **Review what the agent did**: files the agent changed are marked `•`; `a` narrows the list to its last turn
  or its whole session; `d` shows the agent's diff for a file. Select lines in it and insert a reference to
  comment on them. The session scope lists files an agent turn changed; their diff is the net change since the
  first turn, so it can include your own edits to those files in between.
- **Find** (`f` file names, `s` file contents) across the repository, or across the current folder outside one.

## Keys

In the file list:

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move |
| `←` / `h` / `Backspace` | Up one folder |
| `→` / `l` | Open a folder, or a file in the preview |
| `Enter` | Open a folder, or a file in the preview (line mode) |
| `i` | Insert `@path` for the marked files, or the selected one |
| `Space` | Mark or unmark a file |
| `e` | Edit in your editor |
| `Tab` | Line cursor in the preview |
| `d` | Cycle the preview: file → diff vs HEAD → agent diff |
| `m` | Markdown: rendered / source |
| `w` | Wrap long lines |
| `v` | Hide or show the preview |
| `J` `K` / `PgUp` `PgDn` / `Ctrl+D` `Ctrl+U` | Scroll the preview |
| `g` | Changed files only |
| `a` | Agent scope: all files → last turn → session |
| `f` / `s` | Find files / search text |
| `.` | Show or hide dotfiles |
| `/` | Filter the folder by name (unbound letters start a filter too) |
| `Esc` / `q` | Close (or leave find) |

In line mode (the preview has the cursor):

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move the cursor |
| `PgUp` `PgDn` / `Ctrl+D` `Ctrl+U` / `J` `K` | Move by a page |
| `g` / `G` | First / last line |
| `Space` or `v` | Start or end a range selection |
| `Enter` / `i` | Insert `@path#L…` for the line or range |
| `e` | Edit at the cursor line |
| `Tab` / `Esc` / `←` | Back to the list |

Keys that are unavailable right now (for example `g` outside a git repository) are hidden from the hint bar;
pressing them says why.

## How the agent knows about your edit

1. `e` snapshots the whole working tree into a git tree object using a throwaway index (your staging area is
   untouched).
2. Your editor runs in the terminal's alternate screen; the chat is restored when you quit.
3. The tree is snapshotted again and diffed. Changes (or none) are reported; a notice is added to the
   conversation for the agent's next turn, with the full diff, or the file list and tree ids if it is large.

It refuses to start while the agent is working. Outside a git repository only the file you opened is diffed.
The snapshots add unreferenced objects to `.git/objects`, which `git gc` prunes. Untracked files over 10 MB are
left out of snapshots, so they are neither hashed nor reported (one that grows past 10 MB between two
snapshots shows as deleted).

**What reaches the agent:** the diff covers every tracked and untracked file that is not gitignored. Gitignored
files are never included, but a secrets file you have not ignored yet (`.env.local`, a key) is, if it changes
while your editor is open. Add such files to `.gitignore`.

## Requirements and limits

- `git` for markers, diffs, agent tracking and in-repo find. `rg` is used for text search outside a repo if
  installed; otherwise `find` and `grep`.
- Opening at a line works for vi, vim, nvim, nano, emacs, micro, kak, hx, subl, zed and VS Code's family. Other
  editors open the file without a line. Only nvim has been tested.
- GUI editors (VS Code's family, subl, zed, xed) get `--wait` added unless your `$EDITOR` already has `--wait`
  or `-w`, so the plugin waits for you to close the file before diffing.
- `$VISUAL` / `$EDITOR` is split like a shell would split it: quote a path that contains spaces, e.g.
  `EDITOR='"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -w'`. Variables and `~` are not
  expanded.
- Line references (`@path#L12-20`) are text that the agent resolves with its read tool; omp does not expand
  them itself.
- Rendered Markdown and indented JSON are view-only: their rows are not lines of the file, so they cannot
  produce line references.
- Agent tracking records what changed, not what the agent read, and relies on git keeping its snapshot objects.
  Each prompt's "before" snapshot is taken before the agent starts (omp waits for it, up to 10 s), so the
  agent's first edits are not missed. In a huge repository that can delay the start of a turn. The 10 s limit
  assumes omp's default extension handler timeout (30 s); with a lower `extensionHandlerTimeout`, a slow snapshot
  is abandoned sooner.
- Special files (named pipes, devices, sockets) are listed but not previewed.
- Outside a git repository, find skips hidden entries and `node_modules`, `dist`, `build`, `target`, `venv`,
  `__pycache__`, `site-packages` and `coverage`, and lists at most 50,000 files. Text search takes a fixed
  string, not a regex, and ignores case unless the query has a capital letter.

## Security

- File contents, file names and search hits are drawn with control characters made visible (`␛`, `␇`…), so a
  file cannot send escape sequences to your terminal. The agent still receives your edit's diff unchanged.
- git runs with `core.fsmonitor` and every configured filter driver disabled, and diffs run without external
  diff or textconv drivers, so a repository's `.git/config` cannot make the plugin run a program. One side
  effect: a git-lfs file the agent changes is snapshotted with its content rather than its LFS pointer.
  git's own `safe.directory` check still refuses repositories owned by another user.

## Development

```sh
bun install
bun test tests        # unit tests, git integration tests and browser tests (omp's modules are stubbed)
bun run typecheck     # type-check against shims.d.ts
omp plugin link .     # run your checkout in omp
```

Issues and pull requests are welcome at <https://github.com/mindsers/omp-lens>. Please run the tests and the
type check before opening a pull request.

The code is plain TypeScript; omp runs it directly. `host.ts` and `shims.d.ts` describe the parts of omp's API
the plugin uses, since omp ships without type declarations.
