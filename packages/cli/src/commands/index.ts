import { defineCommand } from "citty";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { assertInitialized } from "../config";
import { readDaemonPid, startDaemon } from "../daemon-control";
import { embedDisabledPath, needsReindexPath } from "../daemon-jobs";
import {
  qmdLockPath,
  qmdLockStatus,
  releaseQmdLock,
  tryAcquireQmdLock,
  type QmdLockTheme,
} from "../qmd-locks";
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
    const lock = await tryAcquireQmdLock("index");
    if (lock.busy) {
      const elapsedSec = Math.max(
        0,
        Math.round((Date.now() - lock.startedAt.getTime()) / 1000),
      );
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
      await releaseQmdLock(lock);
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
 * Cancel the currently-running qmd job. Reads the per-theme locks to
 * find the holder PID, sends SIGTERM, writes the `embed-disabled`
 * marker if cancelling an embed (so the next reconciliation doesn't
 * silently re-resume the work the user just stopped), waits up to 5s
 * for the lock to be released, prints `✓ cancelled <theme>`.
 *
 * No-op (with a friendly message) when nothing is running.
 */
const cancelSubcommand = defineCommand({
  meta: {
    name: "cancel",
    description: "Cancel the running qmd job (model download, indexing, or embedding).",
  },
  async run() {
    await assertInitialized();
    const locks = qmdLockStatus();
    const themes = (Object.keys(locks) as QmdLockTheme[]).filter(
      (t) => locks[t] !== undefined,
    );
    if (themes.length === 0) {
      console.log(`${pc.dim("nothing to cancel — no qmd job running.")}`);
      return;
    }
    for (const theme of themes) {
      const info = locks[theme]!;
      // For embeds specifically, write the disable marker first so the
      // daemon's post-job reconcile doesn't immediately re-queue.
      if (theme === "embed") {
        writeFileSync(embedDisabledPath(), "", "utf-8");
      }
      try {
        process.kill(info.pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          console.error(
            `signal pid ${info.pid} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await waitForLockRelease(theme, 5_000);
      console.log(`${pc.green("✓")} cancelled ${theme}`);
    }
  },
});

async function waitForLockRelease(theme: QmdLockTheme, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(qmdLockPath(theme))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Timeout — caller proceeds anyway; the lock will be reclaimed via
  // stale-PID logic on next acquire if the holder really is dead.
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
