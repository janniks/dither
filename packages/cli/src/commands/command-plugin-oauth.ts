// `dither plugin oauth` — run an OAuth 2.0 auth-code flow for the user's own
// app and print the tokens. Defaults to PKCE; passing --client-secret
// switches to the confidential-client flow (Stack Exchange, Reddit, GitHub,
// Notion). Generic: every URL is supplied by the user; the command ships
// zero provider knowledge.

import { defineCommand } from "citty";
import pc from "picocolors";
import {
  buildAuthUrl,
  exchangeCode,
  generatePkce,
  generateState,
} from "../pkce";
import { listenForCode } from "../oauth-listen";
import { openBrowser } from "../open-browser";

export const oauthSubcommand = defineCommand({
  meta: {
    name: "oauth",
    description:
      "Run an OAuth 2.0 auth-code flow (PKCE by default; --client-secret for confidential clients) and print the tokens.",
  },
  args: {
    "client-id": {
      type: "string" as const,
      required: true,
      description: "OAuth app client_id.",
    },
    "client-secret": {
      type: "string" as const,
      description:
        "OAuth app client_secret. Pass for providers that don't support PKCE (Stack Exchange, Reddit, GitHub classic, Notion). Switches the flow to confidential auth-code.",
    },
    "auth-url": {
      type: "string" as const,
      required: true,
      description: "Provider's authorize endpoint (e.g. https://accounts.spotify.com/authorize).",
    },
    "token-url": {
      type: "string" as const,
      required: true,
      description: "Provider's token endpoint (e.g. https://accounts.spotify.com/api/token).",
    },
    scopes: {
      type: "string" as const,
      required: true,
      description: "Comma-separated scope list; joined with spaces on the wire.",
    },
    port: {
      type: "string" as const,
      default: "8888",
      description: "Local callback server port (default 8888).",
    },
    timeout: {
      type: "string" as const,
      default: "300",
      description: "Seconds to wait for the browser callback before aborting (default 300).",
    },
    "no-open": {
      type: "boolean" as const,
      default: false,
      description: "Don't auto-open the browser. URL is still printed.",
    },
    json: {
      type: "boolean" as const,
      default: false,
      description: "Print result as one-line JSON to stdout (suppresses human-readable output).",
    },
  },
  async run({ args }) {
    const port = Number.parseInt(args.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      process.stderr.write(`error: invalid --port '${args.port}'\n`);
      process.exit(1);
    }
    const timeoutSec = Number.parseInt(args.timeout, 10);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      process.stderr.write(`error: invalid --timeout '${args.timeout}'\n`);
      process.exit(1);
    }
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const scopes = args.scopes.split(",").map((s) => s.trim()).filter(Boolean);
    const secret = args["client-secret"];

    const pkce = secret ? null : generatePkce();
    const state = generateState();
    const url = buildAuthUrl({
      authUrl: args["auth-url"],
      clientId: args["client-id"],
      scopes,
      redirectUri,
      state,
      challenge: pkce?.challenge,
    });

    process.stderr.write(`${pc.dim("redirect uri:")} ${redirectUri}\n`);
    process.stderr.write(
      `${pc.dim("note:")} register the redirect uri above in your provider dashboard if you haven't already.\n`,
    );
    process.stderr.write(`${pc.dim("authorize:")} ${url}\n\n`);

    const codePromise = listenForCode({
      port,
      expectedState: state,
      timeoutMs: timeoutSec * 1000,
      onReady: () => {
        if (args["no-open"]) {
          process.stderr.write(`${pc.dim("listening on")} ${redirectUri} ${pc.dim("(open the authorize url above manually)")}\n`);
          return;
        }
        process.stderr.write(`${pc.dim("listening on")} ${redirectUri} ${pc.dim("(opening browser)")}\n`);
        openBrowser(url);
      },
    });

    let code: string;
    try {
      code = await codePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        tokenUrl: args["token-url"],
        clientId: args["client-id"],
        code,
        redirectUri,
        verifier: pkce?.verifier,
        clientSecret: secret,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          refresh_token: tokens.refresh_token ?? null,
          access_token: tokens.access_token,
          expires_in: tokens.expires_in,
          scope: tokens.scope,
        })}\n`,
      );
      return;
    }

    process.stderr.write("\n");
    if (tokens.refresh_token) {
      process.stderr.write(`${pc.green("✓")} refresh_token:\n`);
      process.stdout.write(`${tokens.refresh_token}\n\n`);
    } else {
      process.stderr.write(
        `${pc.dim("(none — provider returned no refresh_token; re-run this command to renew)")}\n\n`,
      );
    }
    const expiryNote = tokens.expires_in ? ` (expires in ${tokens.expires_in}s)` : "";
    process.stderr.write(`${pc.green("✓")} access_token${expiryNote}:\n`);
    process.stdout.write(`${tokens.access_token}\n`);
    if (tokens.scope) {
      process.stderr.write(`${pc.dim("scope:")} ${tokens.scope}\n`);
    }
  },
});
