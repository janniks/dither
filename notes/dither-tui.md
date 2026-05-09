# dither tui

New interactive command: `dither tui`.

## Behavior

- Launches a full-screen interactive TTY session (alternate screen buffer, raw mode, hidden cursor) and restores the terminal cleanly on exit / Ctrl+C / SIGINT / SIGTERM.
- Two-pane layout, redrawn in place via ANSI cursor moves (no full clears between frames to avoid flicker):
  - **Left:** search bar at top + scrollable file list below. Arrow keys (↑/↓) move selection; PgUp/PgDn jump; Home/End snap. Typing filters the list incrementally (fuzzy match, highlight matched chars).
  - **Right:** live preview of the selected file's content with syntax highlighting.
- Enter "opens" the selected file (full preview takes over, or pager mode — TBD; first cut: just expand the preview pane). Esc clears the search; Esc again or `q` exits.

## Inspirations

- **pi-tui** (pi.dev) — clean keybinding model, single-screen redraw loop, sensible default colors, no heavyweight framework. Match its feel: fast, quiet, no chrome.
- Tiny zero/low-dep TS libs to lean on (pick the smallest that does the job; do not pull a full TUI framework like ink/blessed):
  - `picocolors` — ANSI colors, ~1KB, drop-in for chalk.
  - `sisteransi` — ANSI escape sequence helpers (cursor, screen, erase). Used by clack/prompts.
  - `@clack/prompts` or `@inquirer/prompts` — only if we want a prebuilt search/select widget; otherwise roll our own using sisteransi + readline raw mode.
  - `mri` / `cac` — arg parsing if the subcommand grows flags.
  - For syntax highlighting in the preview pane: `cli-highlight` (uses highlight.js, heavier) or `chalk-highlight` style minimal tokenizer. Prefer something tree-shakeable; if size matters, ship a small Shiki-themed renderer or hand-roll per language.

## Implementation notes

- Use Node/Deno `process.stdin.setRawMode(true)` + a keypress decoder (don't pull `keypress` npm — write the ~30 lines for arrows / Enter / Esc / Ctrl+C / printable chars).
- Render loop: diff-based. Track previous frame; only repaint changed lines. sisteransi's `cursor.to(x,y)` + `erase.line` is enough.
- Resize: listen on `process.stdout` `resize` and re-layout.
- File source: same listing the rest of `dither` already uses (don't shell out to `find`); respect ignore rules.
- Preview: read up to N KB, detect binary, fall back to a "binary file" placeholder. Highlight by extension.
- No mouse support in v1.
- No external state — purely a viewer; Enter's "open" action should be configurable later (editor / external pager / inline).

## Out of scope (v1)

- Multi-select, tagging, file actions (delete/move).
- Persistent search history.
- Theming beyond a single default palette.
