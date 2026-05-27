import { spawn as nodeSpawn } from "node:child_process";
import { findProtectedPathInError, isMacOS } from "./tcc-hint";
import type { RunHandle } from "./run-log";

/**
 * Supervise a plugin's Deno child process: spawn, parse NDJSON control
 * messages on stderr (progress + reschedule), journal everything that
 * isn't a control message as `{kind: "stderr"}`, watch for
 * FDA/PermissionDenied lines to surface the macOS TCC hint, record the
 * child PID into the run journal.
 *
 * Returns once the child exits. Failures are surfaced via the result
 * (non-zero `exitCode`, populated `error`) — Supervisor itself only
 * rejects on a spawn error.
 */

export interface ProgressMessage {
  message: string;
  done?: number;
  total?: number;
}

export interface RescheduleHint {
  afterMs: number;
  reason?: string;
}

export interface SuperviseResult {
  exitCode: number;
  lastReschedule: RescheduleHint | null;
  /** Set when stderr sniffing matched a macOS-protected path on EPERM. */
  fdaPath: string | null;
}

export interface SuperviseOptions {
  denoPath: string;
  denoArgs: string[];
  env: NodeJS.ProcessEnv;
  journal: RunHandle;
  /** Injectable for tests. Defaults to node:child_process spawn. */
  spawn?: typeof nodeSpawn;
}

interface RescheduleMessage {
  kind: "reschedule";
  afterMs: number;
  reason?: string;
}

type ControlMessage = (ProgressMessage & { kind: "progress" }) | RescheduleMessage;

function parseControl(line: string): ControlMessage | null {
  if (!line || line[0] !== "{") return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj._dither === "progress") {
      if (typeof obj.message !== "string") return null;
      return {
        kind: "progress",
        message: obj.message,
        done: typeof obj.done === "number" ? obj.done : undefined,
        total: typeof obj.total === "number" ? obj.total : undefined,
      };
    }
    if (obj._dither === "reschedule") {
      if (typeof obj.afterMs !== "number" || obj.afterMs <= 0) return null;
      return {
        kind: "reschedule",
        afterMs: obj.afterMs,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function supervise(opts: SuperviseOptions): Promise<SuperviseResult> {
  const spawn = opts.spawn ?? nodeSpawn;
  let fdaPath: string | null = null;
  let lastReschedule: RescheduleHint | null = null;

  return new Promise<SuperviseResult>((res, rej) => {
    const child = spawn(opts.denoPath, opts.denoArgs, {
      env: opts.env,
      stdio: ["inherit", "inherit", "pipe"],
    });
    if (typeof child.pid === "number") {
      // Recorded so `readSummary` can tell a still-running run from one
      // whose process exited before finalizing result.json. Best-effort.
      void opts.journal.setChildPid(child.pid);
    }
    let buf = "";
    child.stderr!.setEncoding("utf-8");
    const handleLine = (line: string): void => {
      const msg = parseControl(line);
      if (msg) {
        if (msg.kind === "progress") {
          void opts.journal.append({
            kind: "progress",
            message: msg.message,
            done: msg.done,
            total: msg.total,
          });
          return;
        }
        // Last reschedule wins if a plugin sends multiple. Journal each.
        lastReschedule = { afterMs: msg.afterMs, ...(msg.reason ? { reason: msg.reason } : {}) };
        void opts.journal.append({
          kind: "reschedule",
          afterMs: msg.afterMs,
          ...(msg.reason ? { reason: msg.reason } : {}),
        });
        return;
      }
      void opts.journal.append({ kind: "stderr", line });
      if (isMacOS() && fdaPath === null && /PermissionDenied|EPERM/i.test(line)) {
        const path = findProtectedPathInError(line);
        if (path) fdaPath = path;
      }
    };
    child.stderr!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr!.on("end", () => {
      if (buf) handleLine(buf);
    });
    child.on("error", rej);
    child.on("close", (code) => {
      res({ exitCode: code ?? -1, lastReschedule, fdaPath });
    });
  });
}
