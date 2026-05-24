// `dither plugin oauth` — run a PKCE OAuth flow for the user's own app and
// print a refresh_token. Generic: every URL is supplied by the user; the
// command ships zero provider knowledge.

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
      "Run a PKCE OAuth flow against the user's own app and print the refresh_token.",
  },
  args: {
    "client-id": {
      type: "string" as const,
      required: true,
      description: "OAuth app client_id.",
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
  },
  async run({ args }) {
    const port = Number.parseInt(args.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      process.stderr.write(`error: invalid --port '${args.port}'\n`);
      process.exit(1);
    }
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const scopes = args.scopes.split(",").map((s) => s.trim()).filter(Boolean);

    const { verifier, challenge } = generatePkce();
    const state = generateState();
    const url = buildAuthUrl({
      authUrl: args["auth-url"],
      clientId: args["client-id"],
      scopes,
      redirectUri,
      challenge,
      state,
    });

    process.stderr.write(`${pc.dim("redirect uri:")} ${redirectUri}\n`);
    process.stderr.write(
      `${pc.dim("note:")} register the redirect uri above in your provider dashboard if you haven't already.\n`,
    );
    process.stderr.write(`${pc.dim("authorize:")} ${url}\n\n`);

    const codePromise = listenForCode({
      port,
      expectedState: state,
      timeoutMs: 300_000,
      onReady: () => {
        process.stderr.write(`${pc.dim("listening on")} ${redirectUri} ${pc.dim("(opens browser)")}\n`);
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
        verifier,
        redirectUri,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    }

    process.stderr.write("\n");
    process.stdout.write(`${pc.green("✓")} refresh_token:\n`);
    process.stdout.write(`${tokens.refresh_token}\n\n`);
    process.stdout.write(`${pc.green("✓")} access_token (expires in ${tokens.expires_in}s):\n`);
    process.stdout.write(`${tokens.access_token}\n`);
    if (tokens.scope) {
      process.stderr.write(`${pc.dim("scope:")} ${tokens.scope}\n`);
    }
  },
});
