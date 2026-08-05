"use client";

// Hero CTAs — all variant explorations are decided and cemented:
// primary = npm command (blend of solid + card styles), copy button = Card
// (AgentsRow default), manifesto link = pill with Scroll icon.

import { useState } from "react";
import { Scroll } from "lucide-react";
import { GitHubLogoIcon } from "@radix-ui/react-icons";
import { AgentsRow } from "./marketing/agents-row";

const PRIMARY_BASE =
  "inline-flex items-center justify-center gap-2 rounded-[10px] text-sm no-underline transition-colors";

export function ManifestoLink() {
  return (
    <a
      href="#manifesto"
      className="border bg-fd-card text-fd-muted-foreground hover:text-fd-foreground hover:border-fd-primary/40 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm leading-5 no-underline transition-colors"
    >
      <Scroll size={14} className="text-[#99D892]" />
      Read Manifesto
    </a>
  );
}

export function HeroCtas() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-8 flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-3">
        {/* npm command as the primary CTA — the solid variant's presence
            (primary-tinted border/fill) on the grey card base of "lite".
            Copies the command to the clipboard; both labels are stacked in
            one grid cell so the swap causes no layout shift. */}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText("npm i -g dither");
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className={`${PRIMARY_BASE} border border-fd-primary/40 bg-fd-primary/10 hover:bg-fd-primary/20 text-fd-foreground cursor-pointer px-4 py-3 font-mono font-medium tracking-tight`}
        >
          <span className="grid text-center">
            <span
              style={{ gridArea: "1/1" }}
              className={copied ? "invisible" : undefined}
            >
              npm i -g dither
            </span>
            <span
              style={{ gridArea: "1/1" }}
              className={copied ? undefined : "invisible"}
            >
              Copied ✓
            </span>
          </span>
        </button>
        <a
          href="https://github.com/janniks/dither"
          target="_blank"
          rel="noreferrer"
          className="border bg-fd-card hover:bg-fd-accent inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-3 text-sm font-semibold no-underline transition-colors"
        >
          <GitHubLogoIcon className="size-4" />
          GitHub
        </a>
      </div>
      <AgentsRow />
    </div>
  );
}
