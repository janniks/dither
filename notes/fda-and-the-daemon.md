---
date: 2026-05-07
tags: [security, daemon, macos, plugins]
---

# Full Disk Access and the future daemon

## The concern

Today `dither plugin run` works in a terminal that has macOS Full Disk Access. FDA is **inherited from the parent process at spawn time**. That works fine for hand-driven runs.

The daemon model (per `architecture.md`: launchd LaunchAgent or self-respawn) breaks this in non-obvious ways. Anything reading protected macOS data — `~/Library/Messages/chat.db`, Notes (`~/Library/Group Containers/group.com.apple.notes/`), Mail, Photos, Calendars — needs the **daemon's** binary path to be granted FDA. The terminal's grant is irrelevant once the daemon is the thing spawning plugins.

## What macOS actually grants

- FDA is granted to a **specific binary path on disk**, not a process name. macOS resolves symlinks for the grant.
- If the granted binary is replaced (npm reinstall, homebrew upgrade, version bump that rewrites the launcher), the grant is **revoked silently** and must be re-granted manually. Users hate this.
- Child processes inherit the grant. So a daemon-with-FDA spawning Deno spawning the iMessage plugin works — as long as the daemon binary itself was granted.

## Concrete failure modes for our setup

1. **`dither` shipped via npm.** `bin/dither` is typically a launcher script under `node_modules/<scope>/bin/` symlinked from `/usr/local/bin/dither`. macOS resolves the symlink to the launcher _file_, which is JS executed by `node`. The grant ends up on `node`. **Granting FDA to a generic `node` binary is dangerously overbroad** — every Node process the user runs gets FDA. This is a non-starter.
2. **`dither` self-respawned daemon.** Same problem. The daemon is just `node` again.
3. **launchd LaunchAgent plist pointing at `node`.** Same problem with extra steps.
4. **A signed `.app` wrapper.** Workable: macOS treats the `.app` as the FDA target, and the user grants it once. But we don't ship one, and signing requires Apple Developer credentials.
5. **A standalone signed binary (e.g. `bun build --compile` or `deno compile` of the daemon).** Workable: a single dedicated binary the user grants FDA to. Survives npm churn because the binary lives independently. Architecture.md already mentions this option (`bun build --compile`).

## Implications for plugins like iMessage

The iMessage plugin is the canary. Any plugin that reads macOS-protected directories has the same issue:

- **Notes** plugin (read `NotesV7.storedata`).
- **Mail** plugin (read `~/Library/Mail`).
- **Photos** plugin (read `~/Pictures/Photos Library.photoslibrary/`).
- **Calendar** plugin (read `~/Library/Calendars`).
- **Reminders** plugin (read `~/Library/Group Containers/group.com.apple.reminders/`).

All of them need the same daemon-FDA path. If we don't solve this once, every macOS-system plugin re-rediscovers the same UX cliff.

## What we should decide before the daemon ships

1. **What is the FDA-target binary?** Probably a single compiled launcher (`dither-daemon`) the user grants once. The npm-shipped `dither` CLI can route to it.
2. **How does the user grant it?** A `dither doctor` or `dither setup` command that prints the path + instructions, and detects "looks like FDA isn't granted" cases (open `~/Library/Messages/chat.db` test read on first daemon start, fail clearly with a remediation message).
3. **What happens on version bumps?** Either:
   - Use a stable path (`/usr/local/libexec/dither/dither-daemon`, never overwritten in place — atomic rename on update).
   - Document the re-grant requirement and detect missing FDA loudly post-update.
4. **Plugins that don't need FDA must still work without it.** A daemon without FDA should still run a Slack-ingest or RSS plugin. Plugins requesting FDA-protected paths (via their `files[]` declarations) get an upfront "this plugin needs the daemon to have FDA — set up: …" install-time error instead of a runtime EPERM 4 minutes into the first run.

## Pointers

- `imsg`'s troubleshooting (`test.local/inspiration/imsg/docs/permissions.md`) is prior art for the same wall — they hit it with their CLI and document the recipe of "grant FDA to whichever shell wrapper is launching this." We can lift their recommendations.
- macOS docs on TCC: https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac

## Status

Not blocking the iMessage plugin v0 (terminal-launched runs work fine today). Blocking the daemon. Should be a sibling spec / architectural decision before any LaunchAgent or self-respawn lands.
