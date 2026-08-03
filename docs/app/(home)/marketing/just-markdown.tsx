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
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Archive your digital interactions as markdown, then search and sort
          them. There&apos;s no database, no second copy, no proprietary
          format — your data is plain files you can edit, grep, or move
          without dither. Point a collection at your existing Obsidian vault
          and it shows up alongside plugin-written entries, indexed in place.
        </p>
      </div>

      <Terminal className="max-w-none font-mono text-[12.5px] leading-[20px]">
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
