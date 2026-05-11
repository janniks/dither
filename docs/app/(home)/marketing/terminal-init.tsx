"use client";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

export function TerminalInit() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-2">
      <div className="flex justify-center md:justify-start">
        <Terminal>
          <TypingAnimation>$ dither init ~/notes</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Created ~/notes/.dither
          </AnimatedSpan>
          <AnimatedSpan className="text-green-500">
            ✔ qmd index ready (lexical + semantic)
          </AnimatedSpan>
          <TypingAnimation>$ dither add notes/idea.md</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Indexed notes/idea.md · 1.2 KB · 4 chunks
          </AnimatedSpan>
          <TypingAnimation>$ dither search &quot;ranking signals&quot;</TypingAnimation>
          <AnimatedSpan className="text-fd-muted-foreground">
            2 results · 12ms
          </AnimatedSpan>
          <AnimatedSpan>
            <span className="text-blue-500">notes/idea.md</span>{" "}
            <span className="text-fd-muted-foreground">· 3 days ago</span>
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground pl-4">
            ...recency should decay by query intent, not by clock...
          </AnimatedSpan>
        </Terminal>
      </div>
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Try it in 5 seconds.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          Entries are markdown files. Collections are folders. The index is a
          single qmd file. Everything else is convenience on top.
        </p>
      </div>
    </section>
  );
}
