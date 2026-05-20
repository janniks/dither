import { defineCommand } from "citty";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { assertInitialized } from "../config";
import { readDaemonPid, startDaemon } from "../daemon-control";
import { embedDisabledPath, needsReindexPath } from "../daemon-jobs";
import {
  acquireTheme,
  releaseTheme,
  status,
  statusAll,
  themeLockPath,
  type LockTheme,
} from "../locks";
import { updateIndex } from "../update-index";

/**
 * Trigger the daemon to (re-)reconcile qmd state. Clears the
 * `embed-disabled` marker (so a previously cancelled embed resumes),
 * touches `needs-reindex` so the reconciler queues a full reindex, and
 * sends SIGHUP to the daemon. The daemon owns the actual work.
 *
 * If the daemon isn't running, it gets started transparently — same
 * model as `dither init`.
 */
const updateSubcommand = defineCommand({
  meta: {
    name: "update",
    description: "Re-scan the library and refresh the qmd index.",
  },
  async run() {
    await assertInitialized();

    // Clear embed-disabled so a previously cancelled embed becomes
    // eligible again on the next daemon reconcile.
    if (existsSync(embedDisabledPath())) {
      try {
        unlinkSync(embedDisabledPath());
      } catch {
        // Lost-the-race; fine.
      }
    }

    // Acquire qmd-index.lock so a concurrent daemon-side index job
    // doesn't fight us at the SQLite layer. Non-blocking — if the
    // daemon is already indexing, print the uniform busy message,
    // touch needs-reindex (so the daemon's next reconcile covers any
    // new files), and exit.
    const handle = await acquireTheme("index");
    if (handle === null) {
      const busy = status("index");
      const elapsedSec = busy
        ? Math.max(0, Math.round((Date.now() - busy.startedAt.getTime()) / 1000))
        : 0;
      console.error(
        `${pc.yellow("⚠")} qmd is busy: indexing (started ${elapsedSec}s ago).`,
      );
      console.error(`  ${pc.dim("watch with `dither status`. needs-reindex queued for catch-up.")}`);
      writeFileSync(needsReindexPath(), "", "utf-8");
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = await updateIndex();
    } finally {
      await releaseTheme(handle);
    }
    console.log(
      `index updated: ${result.collections} collection(s), ` +
        `${result.indexed} indexed, ${result.updated} updated`,
    );

    // Signal the daemon to embed any new chunks. In test mode (no
    // daemon running) this is a no-op — the inline updateIndex above
    // has already done what tests are checking. In production the
    // daemon's reconciler picks up needsEmbedding > 0 and embeds.
    const pid = await readDaemonPid();
    if (pid) {
      // Also drop a needs-reindex marker so a coalesced reindex runs
      // again on the daemon side — useful when the daemon was mid-job
      // and our inline update raced; the marker ensures the next
      // reconcile catches anything we missed.
      writeFileSync(needsReindexPath(), "", "utf-8");
      try {
        process.kill(pid, "SIGHUP");
      } catch {
        // Daemon died between readDaemonPid and signal. Not fatal —
        // the marker stays and the next daemon start picks it up.
      }
      console.log(`  ${pc.dim(`daemon (pid ${pid}) notified — embed pass will follow.`)}`);
    }
  },
});

/**
 * Cancel the currently-running qmd job. Writes the `embed-disabled`
 * marker so the daemon's embed loop exits at the next iteration
 * boundary and the post-job reconcile doesn't re-queue. For indexing
 * there's no in-flight cancel hook (qmd's store.update can't be
 * interrupted mid-call), so the message is honest about what cancel
 * does and doesn't do.
 *
 * Previously this SIGTERM'd the daemon PID (lock-holder), which
 * graceful-shut-down the WHOLE daemon — wiping schedulers, watchers,
 * refire timers. That's now removed.
 *
 * No-op (with a friendly message) when nothing is running.
 */
const cancelSubcommand = defineCommand({
  meta: {
    name: "cancel",
    description: "Cancel the running qmd job (embedding can be interrupted; indexing completes).",
  },
  async run() {
    await assertInitialized();
    const locks = statusAll();
    const active = (Object.entries(locks) as [LockTheme, (typeof locks)[LockTheme]][])
      .filter((entry): entry is [LockTheme, NonNullable<(typeof locks)[LockTheme]>] => entry[1] !== null);
    if (active.length === 0) {
      console.log(`${pc.dim("nothing to cancel — no qmd job running.")}`);
      return;
    }
    let failures = 0;
    for (const [theme] of active) {
      if (theme === "embed") {
        writeFileSync(embedDisabledPath(), "", "utf-8");
        const released = await waitForLockRelease(theme, 30_000);
        if (released) {
          console.log(`${pc.green("✓")} cancelled embed`);
        } else {
          failures += 1;
          console.error(
            `${pc.red("✗")} embed cancel timed out; embed-disabled marker written — the current batch will finish, then no new iterations start.`,
          );
        }
        continue;
      }
      // For index + model-download, no in-process cancel hook exists.
      console.log(
        `${pc.dim("→")} ${theme} cannot be interrupted mid-call; current run will complete.`,
      );
    }
    if (failures > 0) process.exit(1);
  },
});

async function waitForLockRelease(theme: LockTheme, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(themeLockPath(theme))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export const indexCommand = defineCommand({
  meta: {
    name: "index",
    description: "Index management (update + cancel).",
  },
  subCommands: {
    update: updateSubcommand,
    cancel: cancelSubcommand,
  },
});
