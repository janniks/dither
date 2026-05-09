"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

function VariantCard({
  n,
  title,
  desc,
  children,
}: {
  n: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <section
      className="border bg-fd-card flex flex-col gap-5 rounded-[20px] p-7"
    >
      <div>
        <div className="text-fd-muted-foreground text-xs font-semibold tracking-[0.08em]">
          {n}
        </div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-fd-muted-foreground mt-1.5 max-w-[600px] text-sm">
          {desc}
        </p>
      </div>
      <div className="flex justify-center bg-fd-muted/30 rounded-xl p-6">
        {children}
      </div>
    </section>
  );
}

export default function TerminalLab() {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-6 pt-16 pb-24">
      <header>
        <Link
          href="/"
          className="text-fd-muted-foreground text-[13px] no-underline"
        >
          ← back
        </Link>
        <h1 className="mt-4 text-5xl font-[650] leading-none tracking-[-0.05em]">
          terminal lab
        </h1>
        <p className="text-fd-muted-foreground mt-3 max-w-[600px] text-base">
          MagicUI terminal showcasing dither commands. Each card is a self-contained
          scenario; pick which to feature on the homepage.
        </p>
      </header>

      <VariantCard
        n="01"
        title="first run · init a vault"
        desc="The hello-world: spin up a local index in seconds."
      >
        <Terminal>
          <TypingAnimation>$ dither init ~/notes</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Created ~/notes/.dither
          </AnimatedSpan>
          <AnimatedSpan className="text-green-500">
            ✔ Default collection: notes
          </AnimatedSpan>
          <AnimatedSpan className="text-green-500">
            ✔ qmd index ready (lexical + semantic)
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            Drop markdown in, run plugins, search across everything.
          </AnimatedSpan>
          <TypingAnimation className="text-blue-500">
            $ dither --help
          </TypingAnimation>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="02"
        title="add a plugin · pull data in"
        desc="Plugins are sandboxed Deno scripts that drop entries into a collection."
      >
        <Terminal>
          <TypingAnimation>$ dither plugin add bookmarks</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Fetched plugins/bookmarks@1.4.0
          </AnimatedSpan>
          <AnimatedSpan className="text-yellow-500">
            ⚠ Requested grants:
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground pl-4">
            net: api.raindrop.io · env: RAINDROP_TOKEN
          </AnimatedSpan>
          <AnimatedSpan className="text-green-500">
            ✔ Granted (saved to .dither/grants.toml)
          </AnimatedSpan>
          <TypingAnimation>$ dither plugin run bookmarks</TypingAnimation>
          <AnimatedSpan>↓ 247 entries · 18s · collection: bookmarks</AnimatedSpan>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="03"
        title="search · hybrid query"
        desc="qmd: lexical + semantic in one pass. Plain language, your corpus only."
      >
        <Terminal>
          <TypingAnimation>$ dither search "rust async runtime"</TypingAnimation>
          <AnimatedSpan className="text-muted-foreground">
            8 results · 12ms
          </AnimatedSpan>
          <AnimatedSpan>
            <span className="text-blue-500">notes/tokio-vs-async-std.md</span>{" "}
            · 2024-11-04
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground pl-4">
            ...tokio's multi-threaded runtime spawns a worker per core...
          </AnimatedSpan>
          <AnimatedSpan>
            <span className="text-blue-500">bookmarks/without.boats-async-and-await.html</span>
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground pl-4">
            ...Future trait, the executor, and how poll() drives state...
          </AnimatedSpan>
          <AnimatedSpan>
            <span className="text-blue-500">chats/2024-09-claude-async-explainer.md</span>
          </AnimatedSpan>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="04"
        title="add an entry · markdown on disk"
        desc="Just a file. dither watches and indexes."
      >
        <Terminal>
          <TypingAnimation>$ dither add notes/idea.md</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Indexed notes/idea.md (1.2 KB · 4 chunks)
          </AnimatedSpan>
          <TypingAnimation>$ dither tag notes/idea.md +draft +ai</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Tags: draft, ai
          </AnimatedSpan>
          <TypingAnimation>$ dither show notes/idea.md</TypingAnimation>
          <AnimatedSpan className="text-muted-foreground">---</AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            title: agentic ranking signals
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            tags: [draft, ai]
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">---</AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            What if recency decayed by query intent...
          </AnimatedSpan>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="05"
        title="MCP server · expose to agents"
        desc="One command, every coding agent now reads from your index."
      >
        <Terminal>
          <TypingAnimation>$ dither mcp serve</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ MCP server listening on stdio
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            tools: search · show · list · add · tag · grep
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            collections: notes · bookmarks · chats · drafts (4)
          </AnimatedSpan>
          <AnimatedSpan>
            Add to Claude Code:{" "}
            <span className="text-blue-500">claude mcp add dither -- dither mcp serve</span>
          </AnimatedSpan>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="06"
        title="reindex · qmd rebuild"
        desc="Rare, but visible. Progress feels like real work."
      >
        <Terminal>
          <TypingAnimation>$ dither index rebuild</TypingAnimation>
          <AnimatedSpan className="text-muted-foreground">
            scanning 12,481 entries across 7 collections...
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱ 64% · 8,012 / 12,481
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground">
            ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 100% · 12,481 / 12,481
          </AnimatedSpan>
          <AnimatedSpan className="text-green-500">
            ✔ Index rebuilt in 47.2s · 1.4 GB → 312 MB
          </AnimatedSpan>
        </Terminal>
      </VariantCard>

      <VariantCard
        n="07"
        title="one-liner pitch"
        desc="Smallest possible scenario for the homepage hero."
      >
        <Terminal>
          <TypingAnimation>$ dither search "that thing about ranking"</TypingAnimation>
          <AnimatedSpan>
            <span className="text-blue-500">notes/agentic-ranking.md</span>{" "}
            <span className="text-muted-foreground">· 3 days ago</span>
          </AnimatedSpan>
          <AnimatedSpan className="text-muted-foreground pl-4">
            ...recency should decay by query intent, not by clock...
          </AnimatedSpan>
        </Terminal>
      </VariantCard>
    </div>
  );
}
