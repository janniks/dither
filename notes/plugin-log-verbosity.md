# plugin log verbosity

For plugin debuggability:

- By default, capture only `console.log` / `console.error` from plugins.
  - Where these surface (TTY, daemon log, file) is TBD.
- Plugins should run in the background by default.
- `--follow` on plugin runs to tail logs live.
- `--verbose` (combinable with `--follow`) also surfaces `console.debug` and other verbose statements.
