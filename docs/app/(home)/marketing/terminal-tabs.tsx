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

function InitDemo() {
  return (
    <Terminal className="!max-h-none min-h-[440px]">
      <TypingAnimation>$ dither init</TypingAnimation>
      <AnimatedSpan className="text-[#99D892]">
        ✔ wrote ~/.dither/config.json
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✔ created library at ~/.dither/library
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✔ pre-downloaded model weights
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✔ wrote welcome.md — open it to get started
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
      <AnimatedSpan className="text-fd-muted-foreground">
        granting: read ~/.dither/library/feeds — net rss.* — 2 collections
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✔ installed rss
      </AnimatedSpan>
      <TypingAnimation>$ dither plugin run rss</TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground">
        rss: pulling 4 feeds...
      </AnimatedSpan>
      <AnimatedSpan className="text-[#99D892]">
        ✔ 12 new entries — feeds/
      </AnimatedSpan>
    </Terminal>
  );
}

function SearchDemo() {
  return (
    <Terminal className="!max-h-none min-h-[440px]">
      <AnimatedSpan className="text-fd-muted-foreground">
        <span className="text-fd-foreground">5</span> collections —{" "}
        <span className="text-fd-foreground">131,582</span> entries
      </AnimatedSpan>
      <TypingAnimation>
        $ dither search &quot;ranking signals&quot;
      </TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground">
        3 results — 18ms
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-[#4AB5EC]">notes/idea.md</span>{" "}
        <span className="text-fd-muted-foreground">— 3 days ago</span>
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-4">
        ...recency should decay by query intent, not the clock...
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-[#4AB5EC]">feeds/hn/2026-04-22.md</span>{" "}
        <span className="text-fd-muted-foreground">— 3 weeks ago</span>
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-4">
        ...BM25 alone misses synonymy; pure embeddings drift on rare terms...
      </AnimatedSpan>
      <TypingAnimation>
        $ dither search &quot;deno permission flags&quot; --in pocket
      </TypingAnimation>
      <AnimatedSpan className="text-fd-muted-foreground">
        2 results — 9ms
      </AnimatedSpan>
      <AnimatedSpan>
        <span className="text-[#4AB5EC]">pocket/deno-runtime-deep-dive.md</span>{" "}
        <span className="text-fd-muted-foreground">— last month</span>
      </AnimatedSpan>
      <AnimatedSpan className="text-fd-muted-foreground pl-4">
        ...--allow-read accepts directory globs, not just paths...
      </AnimatedSpan>
    </Terminal>
  );
}
