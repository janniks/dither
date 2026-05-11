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
          Cron-style schedules, fs watchers, or one-shot manual runs. Plugins
          do the same work whether you trigger them or the daemon does.
        </p>
      </div>
      <div className="flex justify-center md:justify-start">
        <Terminal>
          <TypingAnimation>$ dither schedule add bookmarks --every 1h</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ Scheduled bookmarks every 1h (next: 14:00)
          </AnimatedSpan>
          <TypingAnimation>$ dither watch ~/Inbox</TypingAnimation>
          <AnimatedSpan className="text-fd-muted-foreground">
            watching ~/Inbox · indexed 3 entries · idle
          </AnimatedSpan>
        </Terminal>
      </div>
    </section>
  );
}
