"use client";
import { AnimatedSpan, Terminal } from "@/lib/terminal";

export function ScheduleWatchDemo() {
  return (
    <section className="grid grid-cols-1 items-start gap-8 md:grid-cols-2">
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
      <div className="flex items-start justify-center md:justify-start">
        <Terminal className="!h-auto !max-h-none self-start">
          {/* Command lines use AnimatedSpan (not TypingAnimation) because
              TypingAnimation only accepts a plain string — colored flags and
              values need real child spans, same pattern as terminal-tabs. */}
          <AnimatedSpan>
            <span>
              $ dither plugin run bookmarks{" "}
              <span className="text-[#4AB5EC]">--every</span>{" "}
              <span className="text-[#99D892]">&quot;1h&quot;</span>
            </span>
          </AnimatedSpan>
          <AnimatedSpan>✓ scheduled bookmarks: every 1h</AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            {"  → next run: 15:00"}
          </AnimatedSpan>
          <AnimatedSpan>&nbsp;</AnimatedSpan>
          <AnimatedSpan>
            <span>
              $ dither plugin run notes-inbox{" "}
              <span className="text-[#4AB5EC]">--watch</span>{" "}
              <span className="text-[#99D892]">notes</span>
            </span>
          </AnimatedSpan>
          <AnimatedSpan>✓ watching notes-inbox: notes</AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            {"  → changed: notes/meeting-notes.md"}
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            next: dither plugin list
          </AnimatedSpan>
        </Terminal>
      </div>
    </section>
  );
}
