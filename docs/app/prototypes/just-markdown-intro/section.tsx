"use client";

// Prototype harness copy of the "Sandboxed plugins write markdown." section,
// parameterised on the intro paragraph so five copy variants can be compared.

import { Terminal, TypingAnimation, AnimatedSpan } from "@/lib/terminal";

export function Section({ intro }: { intro: string }) {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          {intro}
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
