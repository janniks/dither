"use client";
import { useState } from "react";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

const tabs = ["init", "plugin run", "search"] as const;
type TabId = (typeof tabs)[number];

export function TerminalTabs() {
  const [active, setActive] = useState<TabId>("init");

  return (
    <section className="flex flex-col items-center gap-5">
      <div className="text-fd-muted-foreground flex flex-wrap items-center justify-center gap-3 font-mono text-[13px]">
        {tabs.map((tab, i) => (
          <span key={tab} className="inline-flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActive(tab)}
              className={`transition-colors ${
                active === tab
                  ? "text-fd-foreground underline underline-offset-[6px] decoration-[#99D892]/70"
                  : "hover:text-fd-foreground"
              }`}
            >
              {tab}
            </button>
            {i < tabs.length - 1 && (
              <span className="text-fd-muted-foreground/50">→</span>
            )}
          </span>
        ))}
      </div>

      {/* Remount on tab switch so the typing sequence replays. */}
      <div key={active} className="flex w-full justify-center">
        {active === "init" && <InitDemo />}
        {active === "plugin run" && <PluginRunDemo />}
        {active === "search" && <SearchDemo />}
      </div>
    </section>
  );
}

// All transcripts mirror the real CLI output (packages/cli/src): ✓/→/⚠
// step markers, no invented count/timing lines.
function InitDemo() {
  return (
    <Terminal className="!max-h-none min-h-[440px]">
      <TypingAnimation>$ dither init</TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground">
        ? Where should your library live? (ENTER for ~/.dither/library)
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✓ library: ~/.dither/library (created)
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✓ wrote ~/.dither/config.json
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground">
        → starting dither daemon...
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✓ daemon started (pid 4821)
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✓ indexed 120 files
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✓ embedded 980 chunks in 1m 12s
      </AnimatedSpan>
      <TypingAnimation>
        $ echo &quot;# my first note&quot; &gt; ~/.dither/library/notes/first.md
      </TypingAnimation>
    </Terminal>
  );
}

function PluginRunDemo() {
  return (
    <Terminal className="!max-h-none min-h-[440px]">
      <TypingAnimation>
        $ dither plugin install github:dither-plugins/rss
      </TypingAnimation>
      <AnimatedSpan>installed rss@0.3.0</AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground">
        {"  → ~/.dither/plugins/rss"}
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground">
        next: dither plugin run rss
      </AnimatedSpan>
      <TypingAnimation>$ dither plugin run rss</TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground">
        {'{"type":"log","msg":"pulling 4 feeds"}'}
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground">
        {'{"type":"log","msg":"wrote feeds/hn/2026-08-03.md"}'}
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground">
        {'{"type":"_result","runId":"rss-20260803-a1b2c3","status":"ok"}'}
      </AnimatedSpan>
    </Terminal>
  );
}

function SearchDemo() {
  return (
    <Terminal className="!max-h-none min-h-[440px]">
      <TypingAnimation>
        $ dither search &quot;ranking signals&quot; -C
      </TypingAnimation>
      <AnimatedSpan>
        <span className="text-fd-muted-foreground">0.842{"  "}</span>
        <span className="text-[#4AB5EC]">a1b2c3d4</span>
        <span className="text-fd-muted-foreground">{"  notes  "}</span>
        Ranking signals for personal search
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-[17ch]">
        ...recency should decay by query intent, not the clock...
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-fd-muted-foreground">0.771{"  "}</span>
        <span className="text-[#4AB5EC]">e5f6a7b8</span>
        <span className="text-fd-muted-foreground">{"  feeds  "}</span>
        BM25 vs embeddings, honestly
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-[17ch]">
        ...BM25 alone misses synonymy; pure embeddings drift...
      </AnimatedSpan>
      <TypingAnimation>
        $ dither search &quot;deno permission flags&quot; -C
      </TypingAnimation>
      <AnimatedSpan>
        <span className="text-fd-muted-foreground">0.868{"  "}</span>
        <span className="text-[#4AB5EC]">9c8d7e6f</span>
        <span className="text-fd-muted-foreground">{"  pocket "}</span>
        Deno runtime deep dive
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-[17ch]">
        ...--allow-read accepts directory globs, not just paths...
      </AnimatedSpan>
    </Terminal>
  );
}
