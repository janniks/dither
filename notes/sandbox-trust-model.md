---
status: thinking
priority: P0
---

# Plugin sandbox: trust model & guarantees

## Why this matters

Dither's value proposition rests on plugins being *cheap to add and safe to
trust*. Users grant a plugin a folder, an env var, or a `net: ["*"]` and
should be able to take that grant *literally*: the plugin can read that
folder, fetch over the network, and that's it. It can't read your SSH keys,
exfiltrate to anywhere it wants, or persist across reboots. Every grant
must mean exactly what it says, with no implicit escape hatches.

This note codifies what the sandbox guarantees today, what it doesn't, and
where work is needed to keep those guarantees credible.

## Threat model

We assume:

- **Plugin code is untrusted.** Could be malicious by author intent, or
  trusted code with a compromised transitive dep (supply-chain attack).
- **The host (dither itself) is trusted.** Native code, FFI, raw process
  spawning all live here. The host is the trust root.
- **The user's machine is trusted.** Plugins are launched by a logged-in
  user; we're not protecting against root or kernel attackers.

Out of scope: timing attacks, kernel-level isolation, resource quotas. In
scope: data confidentiality, capability containment, no implicit privilege
escalation.

## Permission model — explicit guarantees

Each plugin run executes under a Deno child process with a hand-built
permission set. **Every capability is opt-in and scoped.**

### Filesystem read (`--allow-read=<paths>`)

Granted: `pluginDir`, `runDir`, `sdkPath`, declared `files[]` grants,
watch `targets`. Nothing else. The plugin cannot read `~/.ssh/`,
`~/Library/Cookies/`, the user's `.env` files, other plugins' state, or
the dither library itself outside the explicit folder grants the user
accepted at install.

**Caveat to verify**: symlinks inside a granted folder may resolve to
paths outside it. We should `realpath` folder grants at install and treat
those resolved paths as the actual `--allow-read` entries. Status:
not-yet-verified.

### Filesystem write (`--allow-write=<paths>`)

Granted: only `stateDir` (plugin's own state) and `runDir` (this run's
output). The plugin cannot write to `pluginDir` (its own code is read-
only at runtime — prevents a plugin from rewriting itself between runs),
the dither library directly, or anywhere else on disk.

Promotion to the library happens in the *host*, after the run exits, with
its own validation: source-ownership check, collection-grant check,
filename-flat check.

### Network (`--allow-net=<hosts | *>`)

Granted: only the hosts listed in the manifest's `net: [...]` and
explicitly accepted at install. `net: ["*"]` is supported but is
**explicit user opt-in** — we surface "this plugin wants to access any
host" at install time and the user accepts it deliberately.

**Caveats**:
- DNS resolution: Deno's `Deno.resolveDns` requires `--allow-net`, but
  implicit DNS lookups during `fetch()` to a granted host can resolve any
  hostname before the connection is made. With `net: ["*"]` this is moot;
  with a host-list this means a plugin could do DNS exfiltration via
  third-party DNS responses *if* it uses subdomains under granted hosts.
  Acceptable for our scopes.
- npm registry fetches happen via Deno's *own* fetcher during module
  resolution — those run outside the script's sandbox. They go only to
  registry.npmjs.org and resolve our explicit npm specifiers. Verified
  in smoke test 2026-05-08.

### Environment (`--allow-env=<names>` + literal env)

The host **builds the child env from a literal**, not by filtering the
host's env. See `notes/sandbox-env-replace-not-filter.md`.

Effective shape: the plugin's `process.env` contains exactly the names
the host hardcoded (DITHER_* + behavior shims like DEBUG, NODE_ENV,
FORCE_COLOR, NO_COLOR), plus any user-granted manifest env.

The plugin cannot enumerate the user's actual env (`Deno.env.toObject()`
without bare `--allow-env` throws), and the values it sees for hardcoded
shims are sanitized constants — never the host's real values.

### Subprocess execution

**Not granted.** No plugin gets `--allow-run`. Plugins cannot spawn child
processes, period.

### FFI (foreign function interface)

**Never granted.** See `notes/sandbox-ffi-policy.md`. There is no
"scoped FFI" in Deno; granting it once means giving up every other
sandbox. Any native primitive a plugin needs comes from runtime
built-ins (`node:sqlite`, `node:zlib`, `node:crypto`, `node:fs`) or pure-
WASM ports (`npm:sql.js`, `npm:fflate`). Anything else gets vendored into
the *host*, exposed to plugins via a controlled SDK function.

### Subprocess (`--allow-run`)

**Not granted.** Plugins cannot spawn child processes.

### Hardware (`--allow-hrtime`, `--allow-sys`, ...)

**Not granted.** No reason a plugin needs high-resolution timers or
system-info syscalls. Not surfaced.

## What stops a malicious plugin

Walking through what an attacker could try:

| Attack | Sandbox response |
|---|---|
| Read SSH keys | `--allow-read` doesn't cover `~/.ssh/`; throws `NotCapable`. |
| Read user env (API keys) | Child env is host-built literal. The user's env is not present. |
| Exfiltrate via HTTP | Only to `--allow-net` hosts. With `net: ["*"]` this is allowed *and explicitly granted by the user*. |
| Exfiltrate via DNS | DNS calls require `--allow-net`. Bounded by the host list. |
| `dlopen` libc → `system("...")` | `--allow-ffi` not granted. `Deno.dlopen` throws. |
| Spawn `bash -c ...` | `--allow-run` not granted. `Deno.Command.spawn` throws. |
| Write to `~/Library/LaunchAgents` | `--allow-write` doesn't cover it. Throws. |
| Modify own plugin code between runs | `pluginDir` is in `--allow-read` but not `--allow-write`. Throws. |
| Tamper with another plugin's state | Other plugin's `stateDir` is not in this plugin's `--allow-read` or `--allow-write`. Throws. |
| Tamper with the dither library | `libraryRoot` is not in the plugin's `--allow-read` or `--allow-write`. Promotion happens in the host. |
| Inject malicious frontmatter on promote | Host validates source-ownership and collection grants in `plugin-run.ts:planPromotion`. Throws. |

## Known limitations (acceptable today; document, revisit when needed)

- **Resource exhaustion**. A plugin can spin CPU forever or fill `runDir`
  / `stateDir` with garbage. Not a confidentiality issue; could be a DoS
  on the user's machine. Mitigation later via Deno's `--v8-flags` for
  memory caps and a host-side wallclock timeout per run.
- **Allowed-host exfiltration**. With `net: ["*"]` the plugin can send
  whatever it has read to any HTTP endpoint. This is *intended* — `*` is
  the user's explicit grant. Mitigation: only suggest `*` for plugins
  that genuinely need it (URL scrapers, generic web fetchers); push
  others toward host-list grants.
- **Module cache poisoning between runs**. The plugin's `pluginDir/
  node_modules` is read-only at runtime. The cache *is* writable at
  install time, but install-time writes are by the host (running
  `deno cache ...` or similar) — the plugin code doesn't run during
  install. Verified safe.
- **Symlink escape in folder grants**. As above — needs `realpath`
  resolution at install. Status: open.
- **Implicit network during npm resolution**. Deno's own fetcher hits
  the npm registry during module loading regardless of `--allow-net`.
  This is not an exfiltration vector (registry is a public destination
  responding to public package names), but worth noting.
- **No process isolation between runs of the same plugin**. Each run is
  a fresh Deno process, so memory state doesn't leak. But the same
  `stateDir` carries forward — that's the design intent, not a leak.

## Verification status (smoke-tested or explicitly checked)

| Property | Status |
|---|---|
| Stripped child env doesn't break Deno or npm imports | ✅ verified 2026-05-08 |
| `linkedom` + `@mozilla/readability` survive sandbox | ✅ verified |
| `jsdom` crashes via `debug` env probe | ✅ confirmed (drives the env-shim work) |
| `node:sqlite` loads under stripped env | ⏳ to verify |
| `node:sqlite` WAL works under per-plugin `--allow-write=stateDir` | ⏳ to verify |
| Wildcard `--allow-net=*` honored vs literal `"*"` host | ✅ implemented and verified |
| Symlink resolution in folder grants | ⏳ to audit |
| Source-ownership check on promote | ✅ enforced (`plugin-run.ts:130`) |

## What this implies for plugin authors

- A plugin's manifest is a **promise to the user** about capabilities. Be
  honest in `display_name`/`tagline`; the install-time prompt should let
  the user reason about what they're agreeing to.
- Don't request `net: ["*"]` unless you genuinely need it. Host-list when
  possible.
- Don't hand-roll native bindings. Use runtime built-ins (`node:*`) or
  pure-WASM ports.
- Don't store secrets in plugin code; use the manifest env declaration
  so the user can grant via `dither env`.

## What this implies for dither maintainers

- Every PR touching `plugin-run.ts` is a security PR. Treat it that way:
  small, reviewed, with a sandbox impact note.
- The hardcoded env shim list grows only via PR. Each addition gets a
  one-line justification ("`X` probed by `pkg-Y` at import; sanitized to
  empty string").
- New SDK functions (`openStateDb`, future `patchEntry`, future
  `addRelation`) must be analyzed for their sandbox implications before
  landing.
- The trust model is the headline. It belongs in dither's user-facing
  docs, not just internal notes.

## Cross-references

- `notes/sandbox-env-replace-not-filter.md` — env shim approach.
- `notes/sandbox-ffi-policy.md` — never grant FFI, native via host.
- `notes/plugin-state-sqlite.md` — `node:sqlite` is the right pick;
  verifies the FFI-policy implication.
- `packages/cli/src/plugin-run.ts:planPromotion` — source-ownership check.
