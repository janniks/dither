---
status: policy
priority: P1
---

# Plugin sandbox: never grant FFI

## Decision

`--allow-ffi` is **never** granted to dither plugins. There is no "scoped
FFI" in Deno; granting it once means giving up every other sandbox.

## Why FFI is all-or-nothing

Deno's other allow-flags have built-in scoping primitives:

- `--allow-read=path1,path2` — path-scoped.
- `--allow-write=path1,path2` — path-scoped.
- `--allow-net=host1,host2` — host-scoped.
- `--allow-env=name1,name2` — name-scoped.
- `--allow-run=cmd1,cmd2` — command-scoped.

`--allow-ffi` has no such primitive. It's binary: yes or no. Once yes, the
plugin can `Deno.dlopen()` any shared library and call any symbol. From
there, every other restriction collapses:

- Call `system()` from libc → arbitrary shell exec → bypasses `--allow-run`.
- Call `open(2)` / `read(2)` / `write(2)` → arbitrary fs access → bypasses
  `--allow-read` and `--allow-write`.
- Call `socket(2)` / `connect(2)` → arbitrary network → bypasses
  `--allow-net`.
- `mmap` arbitrary files, `ptrace` other processes, etc.

The Deno docs explicitly call FFI "inherently unsafe" for this reason. There
is no engineering work that adds scoping to FFI; it's a property of the
underlying syscall surface.

## Concrete plugin threat model with FFI granted

A malicious or compromised plugin (supply-chain attack on a transitive npm
dep, for instance) with FFI could:

- Read `~/.ssh/`, `~/Library/Cookies/`, browser session data, password
  manager files, `.env` files anywhere on disk.
- Exfiltrate via DNS lookups (which don't go through `--allow-net`) or
  through any allowed HTTP host.
- Install launchd / systemd persistence.
- Patch installed binaries on disk.
- Run a crypto miner indistinguishable from "intensive HTML parsing."

The current sandbox (with `net: ["*"]` granted) limits a hostile plugin to
HTTP exfiltration of files it can already read — which is a small, scoped
list. FFI removes the scope.

## Practical consequence: pick the right sqlite

This rules out npm packages that ship native bindings:

- ❌ `better-sqlite3` — `.node` native binding → needs `--allow-ffi`.
- ❌ `@db/sqlite` (Deno-native) — uses `Deno.dlopen` → needs `--allow-ffi`.

And points to:

- ✅ `node:sqlite` — runtime-provided. Native sqlite is wired into Deno's
  Node compat layer; the plugin gets the JS API without ever needing FFI.
- ✅ `npm:sql.js` — pure WASM. In-memory only, but no FFI required. Right
  for *reading foreign sqlite files* (e.g. iMessage's `chat.db`); wrong for
  plugin-owned persistent state because persistence requires whole-file
  rewrite.

Same logic applies to other native primitives:

- ✅ `node:zlib`, `node:crypto`, `node:fs`, `node:path` — runtime built-ins,
  no grant needed.
- ✅ Pure WASM ports (sql.js, fflate, etc.) — no grant.
- ❌ Anything via `npm install` that drops a `.node` file or uses `napi-rs`.

## What if we genuinely need a binding the runtime doesn't ship?

Don't grant FFI to the plugin. Vendor the binding into the **dither host**:

- Host loads the `.node` file or `dlopen`s the library once at startup.
- Host exposes a controlled JS API (e.g. via the SDK).
- Plugin calls the SDK function; the unsafe call surface lives in trusted
  host code, not user-installed plugin code.

Threat model stays clean: the host is trusted with native code; plugins are
not. Any expansion of plugin capabilities goes through a host-mediated API.

## Out of scope (this note)

- Future Deno work that might add scoped FFI primitives. If/when it lands,
  revisit. Don't bake plans around it.
- A plugin manifest field `"requires-ffi"`. Don't add it; would imply a
  policy in which it might be granted, which we don't want.
