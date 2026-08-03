"use client";

// "Sandboxed plugins write markdown." — an animated plugin run: the command
// is typed, the plugin emits raw JSONL logs, and the written files appear on
// disk. Makes the point that dither is a coordinator over plain files.

import { Terminal, TypingAnimation, AnimatedSpan } from "@/lib/terminal";

export function JustMarkdown() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        {/* TEMPORARY: five intro variants stacked for visual pick-one. Delete
            the four you don't keep (and the numeric markers). */}
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          <span className="opacity-40">1 · </span>
          Plugins write plain markdown straight into your library. No database,
          no proprietary format — just files you can edit, grep, or move.
        </p>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          <span className="opacity-40">2 · </span>
          Your archive stays yours: plain markdown on disk, no database, no
          lock-in. Delete dither tomorrow and everything still reads fine.
        </p>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          <span className="opacity-40">3 · </span>
          Plugins write markdown into your library and dither indexes it in
          place — search and sort everything without a second copy.
        </p>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          <span className="opacity-40">4 · </span>
          Point it at your Obsidian vault and it&apos;s indexed in place,
          searchable alongside plugin-written markdown. No database, no copies.
        </p>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          <span className="opacity-40">5 · </span>
          Markdown in, markdown out — plugin entries and your Obsidian vault,
          indexed in place. No database, no proprietary format.
        </p>
      </div>

      <Terminal className="mx-auto w-full max-w-xl font-mono text-[12.5px] leading-[20px]">
        <TypingAnimation className="text-[12.5px]">
          $ dither plugin run raindrop
        </TypingAnimation>

        <AnimatedSpan className="text-fd-muted-foreground text-[12.5px]">
          {`{"type":"log","msg":"fetching bookmarks since 2026-05-11"}`}
        </AnimatedSpan>
        <AnimatedSpan className="text-fd-muted-foreground text-[12.5px]">
          {`{"type":"log","msg":"2 new, 0 unchanged"}`}
        </AnimatedSpan>

        <AnimatedSpan className="text-[12.5px]">
          {`~/.dither/library`}
        </AnimatedSpan>
        <AnimatedSpan className="text-[12.5px]">
          {`├── raindrop/                    `}
          <span className="text-fd-muted-foreground">{`# just written`}</span>
        </AnimatedSpan>
        <AnimatedSpan className="text-[12.5px]">
          {`│   ├── grug-brained-developer.md`}
        </AnimatedSpan>
        <AnimatedSpan className="text-[12.5px]">
          {`│   └── deno-runtime-deep-dive.md`}
        </AnimatedSpan>
        <AnimatedSpan className="text-[12.5px]">
          {`├── notes/                       `}
          <span className="text-fd-muted-foreground">{`# you write these`}</span>
        </AnimatedSpan>
        <AnimatedSpan className="text-[12.5px]">
          {`└── vault → ~/Documents/Obsidian `}
          <span className="text-fd-muted-foreground">{`# indexed in place`}</span>
        </AnimatedSpan>
      </Terminal>
    </section>
  );
}
