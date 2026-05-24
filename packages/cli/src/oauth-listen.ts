// Local OAuth callback listener. Spins up a node:http server on 127.0.0.1
// only (never 0.0.0.0), waits for /callback?code=...&state=..., validates
// state, resolves with the code. Times out and self-closes if no callback
// arrives. Always closes the server before settling, success or failure.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const DONE_HTML =
  '<!doctype html><meta charset=utf-8><title>OK</title>' +
  '<style>body{font:16px/1.4 system-ui;display:grid;place-items:center;height:100vh;margin:0}</style>' +
  '<div><h1>Authorized.</h1><p>You can close this tab and return to the terminal.</p></div>';

export interface ListenOpts {
  port: number;
  expectedState: string;
  timeoutMs: number;
  /** Fires once the server is bound, with the actual port (resolves `port: 0`
   *  to the OS-assigned port). Tests use this to learn where to send requests
   *  without racing the bind. Production callers ignore it. */
  onReady?: (port: number) => void;
}

export async function listenForCode(opts: ListenOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn());
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(DONE_HTML);
      if (err) {
        finish(() => reject(new Error(`provider returned error: ${err}`)));
        return;
      }
      if (state !== opts.expectedState) {
        finish(() => reject(new Error("state mismatch — possible CSRF, retry")));
        return;
      }
      if (!code) {
        finish(() => reject(new Error("callback missing 'code' param")));
        return;
      }
      finish(() => resolve(code));
    };

    const server = createServer(handler);
    server.on("error", (e) => finish(() => reject(e)));
    server.listen(opts.port, "127.0.0.1", () => {
      if (opts.onReady) {
        const addr = server.address();
        const actual = typeof addr === "object" && addr ? addr.port : opts.port;
        opts.onReady(actual);
      }
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`no callback in ${Math.round(opts.timeoutMs / 1000)}s`)),
      );
    }, opts.timeoutMs);
  });
}
