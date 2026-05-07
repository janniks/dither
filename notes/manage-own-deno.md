# Manage own Deno binary

- Today: `spawn("deno", ...)` in `packages/cli/src/plugin-run.ts` — relies on system Deno on PATH.
- Want: dither owns its Deno. Download from GitHub releases into a cache dir (e.g. `~/.dither/bin/deno`), pin version, use that path when spawning plugins.
- Later: optional self-update (check latest release, swap binary atomically).
- Bonus: removes "is Deno installed?" friction for users; reproducible plugin runtime across machines.
