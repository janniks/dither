# PAPERCUTS

> Agents: read at session start. Append-only dated bullets — things that didn't go as planned, logged so the next session skips the detour. Trigger: 2+ failed attempts before something worked, or a surprise. Add `- spec: <file>` only when the origin matters.

- 2026-07-10 two pre-existing failures on main; don't chase them when your diff looks guilty
  - `tsc --noEmit`: `plugin-host.test.ts:816` — `mtimeMs` not in `WatchTarget` (should be `mtime`)
  - `lifecycle.test.ts` "getStatus reports counts": collections expected 1 got 0 — fails on a clean tree too
- 2026-07-10 also pre-existing: `command-collection.test.ts` both "list" tests fail on a clean tree (md-count column landed between name and source; regexes expect them adjacent)
- 2026-07-10 flaky: daemon.test.ts "rollback: successor never confirms" can catch status.json mid-write (plain writeFile by design; readStatusSnapshot then throws SyntaxError). Rerun before suspecting your diff.
