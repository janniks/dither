"use client";
import { useEffect, useState } from "react";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

const tabs = ["init", "plugin run", "search", "agents"] as const;
type TabId = (typeof tabs)[number];

// Rough per-tab runtime: transcript animation + 2s of rest, then auto-advance.
const CYCLE_MS: Record<TabId, number> = {
  init: 9500,
  "plugin run": 8500,
  search: 7000,
  agents: 8500,
};

// Thin progress strip under the terminal chrome bar — only this terminal
// (the tabbed one) has it; it fills over the tab's cycle and then we advance.
function TabProgress({ durationMs }: { durationMs: number }) {
  return (
    <div className="h-[3px] w-full bg-transparent">
      <div
        className="h-full bg-[#99D892]/60"
        style={{
          width: 0,
          animation: `terminal-tab-progress ${durationMs}ms linear forwards`,
        }}
      />
    </div>
  );
}

export function TerminalTabs() {
  const [active, setActive] = useState<TabId>("init");
  // bumped on manual tab clicks so the timer + progress restart even when
  // re-clicking the active tab
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setActive(tabs[(tabs.indexOf(active) + 1) % tabs.length]);
    }, CYCLE_MS[active]);
    return () => window.clearTimeout(t);
  }, [active, cycle]);

  const pick = (tab: TabId) => {
    setActive(tab);
    setCycle((c) => c + 1);
  };

  const progress = <TabProgress durationMs={CYCLE_MS[active]} />;

  return (
    <section className="mt-10 flex flex-col items-center gap-5">
      <style>{`@keyframes terminal-tab-progress { from { width: 0 } to { width: 100% } }`}</style>
      <div className="text-fd-muted-foreground flex flex-wrap items-center justify-center gap-3 font-mono text-[13px]">
        {tabs.map((tab, i) => (
          <span key={tab} className="inline-flex items-center gap-3">
            <button
              type="button"
              onClick={() => pick(tab)}
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

      {/* Remount on tab switch (and manual re-click) so the typing sequence
          and the progress strip replay together. */}
      <div key={`${active}-${cycle}`} className="flex w-full justify-center">
        {active === "init" && <InitDemo chromeExtra={progress} />}
        {active === "plugin run" && <PluginRunDemo chromeExtra={progress} />}
        {active === "search" && <SearchDemo chromeExtra={progress} />}
        {active === "agents" && <AgentsDemo chromeExtra={progress} />}
      </div>
    </section>
  );
}

type DemoProps = { chromeExtra?: React.ReactNode };

// All transcripts mirror the real CLI output (packages/cli/src): ✓/→/⚠
// step markers, no invented count/timing lines.
function InitDemo({ chromeExtra }: DemoProps) {
  return (
    <Terminal className="!max-h-none min-h-[380px]" chromeExtra={chromeExtra}>
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

function PluginRunDemo({ chromeExtra }: DemoProps) {
  return (
    <Terminal className="!max-h-none min-h-[380px]" chromeExtra={chromeExtra}>
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

function SearchDemo({ chromeExtra }: DemoProps) {
  return (
    <Terminal className="!max-h-none min-h-[380px]" chromeExtra={chromeExtra}>
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
    </Terminal>
  );
}

// Coding agents get the same CLI — your library becomes their context.
function AgentsDemo({ chromeExtra }: DemoProps) {
  return (
    <Terminal className="!max-h-none min-h-[380px]" chromeExtra={chromeExtra}>
      <TypingAnimation>
        $ claude &quot;what did I decide about chunking strategy?&quot;
      </TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground italic">
        ● reading SKILL.md — dither CLI available
      </AnimatedSpan>
      <AnimatedSpan className="text-[#4AB5EC]">
        &gt; dither search &quot;chunking strategy&quot; -C
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-fd-muted-foreground">0.913{"  "}</span>
        <span className="text-[#4AB5EC]">7c4d19ab</span>
        <span className="text-fd-muted-foreground">{"  notes  "}</span>
        Chunking strategy, settled
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-[17ch]">
        ...split on headings, 200-token overlap between chunks...
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-fd-muted-foreground">0.688{"  "}</span>
        <span className="text-[#4AB5EC]">bd20e5f1</span>
        <span className="text-fd-muted-foreground">{"  notes  "}</span>
        Fixed-window chunking, why not
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-[17ch]">
        ...fixed windows cut mid-argument; recall got worse...
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ● you settled on heading-based chunks with 200-token overlap
        (notes/chunking.md)
      </AnimatedSpan>
    </Terminal>
  );
}
