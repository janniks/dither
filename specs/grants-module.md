# Grants file — one type, one reader, one path helper

Source: architecture review 2026-07-10, verified against every reader/writer on disk. Aligns with `plans/grants-redesign.md` intent (one coherent grants concept through install/run/list).

## Problem

- The grants file JSON is the real interface. Its exact on-disk shape (write order, `plugin-install.ts:151-168`):
  `name, version, installedAt, manifest, schedule, watch, env, envRefs, files, net, create, edit`.
- Six files re-declare a subset of that shape by hand, each with its own defaults:
  - `plugin-run.ts:61-68` — private `GrantsFile` (env/envRefs/files/net/create/edit)
  - `plugin-list.ts:21-31` — private `GrantsFile` (version/installedAt/net/create/edit/schedule/watch) + derived `InstalledPluginInfo`
  - `plugin-install-interactive.ts:270-277` — inline type in `readExistingGrants`
  - `command-plugin-shared.ts:156-173` — `ConsentedGrants` + `readConsentedGrants` (schedule/watch)
  - `command-plugin-run.ts:76-78` and `:116-120` — two more inline types
- The path `join(resolveHome(), "grants", `${name}.json`)` is hand-built in 6 files (~9 spots). `home.ts` has a helper for every other channel but not grants.
- "schedule `null` or absent = disabled" is documented in two comment blocks, enforced by luck (every consumer happens to do `p.schedule ? …`).

## Solution

- `home.ts`: add `grantsPath(name)` — replaces all 9 hand-built paths.
- `grants.ts`: add the file layer next to the existing pattern helpers (same file — one grants module, no new file):
  - one exported `Grants` type = the exact on-disk shape above (legacy-optional fields marked optional).
  - `readGrants(name): Grants | null` — the single reader. Normalizes once: `create/edit/net → []`, `watch` absent → `null`. Tolerant of legacy files (missing `installedAt`/`schedule`/`watch`).
  - `writeGrants(name, g)` — `writePrivateJson(grantsPath(name), g)`.
  - `listGrants(): Grants[]` — readdir + `readGrants` each, sorted by name. Returns full `Grants` (a schedule/watch projection would just recreate the derived type this deletes; same process trust domain).
- Delete `plugin-list.ts` entirely (file + `InstalledPluginInfo` + its defaults). `daemon.ts`, `status.ts`, `command-plugin-list.ts` import `listGrants`/`Grants` and dot-access. `scheduleEntriesOf`/`watchEntriesOf` keep working — `Grants` carries `schedule`/`watch`, and `null`/absent stay falsy.
- Delete both private `GrantsFile` types and the four inline shapes; each caller reads via `readGrants` and dots the fields it needs.

## Rough LOC

- Delete: `plugin-list.ts` (~57), two `GrantsFile` types + inline reads (~30), `ConsentedGrants`/`readConsentedGrants` (~18), inline types in run cmd (~10). ≈ 115 out.
- Add: `Grants` + `readGrants`/`writeGrants`/`listGrants` (~45), `grantsPath` (~3). ≈ 48 in.
- Net ≈ −60, and the on-disk shape now equals the in-memory shape (no translation type).

## Constraints (unchanged behavior)

- `envRefs` stay references into `env.json`, resolved at run time (`plugin-run.ts:191-196`) — never copied into grants.
- Per-run overrides layer on top for one run only; `runPlugin` never writes grants.
- Promotion still validates writes against `create`/`edit` (`plugin-run.ts:332-339`), not the manifest.
- No schema change. `writeGrants` round-trips existing files; `configurePlugin`'s read-modify-write preserves every field it didn't touch. `schedule` `null` and absent both mean "disabled" — do not rewrite absent → null.

## Acceptance

- [ ] one `Grants` type; zero private re-declarations or inline grant shapes
- [ ] `grantsPath` in home.ts; no hand-built grants paths remain
- [ ] `plugin-list.ts` deleted; daemon/status/list-cmd consume `listGrants()`
- [ ] legacy null/absent-schedule + absent-watch tested once in `grants.test.ts`
- [ ] daemon + list tests seed grants via `writeGrants`, not hand-crafted JSON
