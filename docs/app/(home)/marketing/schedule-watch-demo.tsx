"use client";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

export function ScheduleWatchDemo() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Hands-off ingest.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          Run on a schedule, watch a folder, or trigger on activity. The
          plugin works the same way — you just don&apos;t have to think
          about it.
        </p>
        <ul className="text-fd-muted-foreground mt-2 flex flex-col gap-1 text-[13px]">
          <li>
            <span className="text-fd-foreground font-mono">schedule</span> —
            cron, every N minutes, or on a wall-clock.
          </li>
          <li>
            <span className="text-fd-foreground font-mono">watch</span> — fs
            events, debounced, batched.
          </li>
          <li>
            <span className="text-fd-foreground font-mono">run</span> — manual
            one-shot for ad-hoc ingests.
          </li>
        </ul>
      </div>
      <div className="flex justify-center md:justify-start">
        <Terminal>
          <TypingAnimation>$ dither schedule add bookmarks --every 1h</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Scheduled bookmarks every 1h
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            next run: 14:00 · last: never · job id: sch_a12f
          </AnimatedSpan>
          <TypingAnimation>$ dither watch ~/Inbox --collection notes</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Watching ~/Inbox → notes
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            + draft-202605.md · indexed (1.2 KB · 4 chunks)
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            + agentic-ranking.md · indexed (0.8 KB · 2 chunks)
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            idle · debouncing
          </AnimatedSpan>
        </Terminal>
      </div>
    </section>
  );
}
