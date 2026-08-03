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
            <span className="text-fd-foreground font-mono">
              dither plugin run
            </span>{" "}
            — manual one-shot ingest.
          </li>
          <li>
            <span className="text-fd-foreground font-mono">--every</span> — cron
            or natural language like{" "}
            <span className="text-fd-foreground font-mono">every 15min</span>.
          </li>
          <li>
            <span className="text-fd-foreground font-mono">--watch</span> — a
            collection or directory, runs on filesystem changes.
          </li>
        </ul>
      </div>
      <div className="flex justify-center md:justify-start">
        <Terminal>
          <TypingAnimation>
            $ dither plugin run bookmarks --every &quot;1h&quot;
          </TypingAnimation>
          <AnimatedSpan>scheduled bookmarks: every 1h</AnimatedSpan>
          <AnimatedSpan>&nbsp;</AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            next: dither plugin list
          </AnimatedSpan>
          <TypingAnimation>
            $ dither plugin run notes-inbox --watch notes
          </TypingAnimation>
          <AnimatedSpan>watching for notes-inbox: notes</AnimatedSpan>
          <AnimatedSpan>&nbsp;</AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            next: dither plugin list
          </AnimatedSpan>
        </Terminal>
      </div>
    </section>
  );
}
