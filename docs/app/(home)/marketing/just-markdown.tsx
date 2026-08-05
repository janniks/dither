"use client";

// "Sandboxed plugins write markdown." — an animated plugin run: the command
// is typed, the plugin emits raw JSONL logs, and the written files appear on
// disk. Makes the point that dither is a coordinator over plain files.

import { useState } from "react";
import { Terminal, TypingAnimation, AnimatedSpan } from "@/lib/terminal";

// TEMPORARY: inline prototype picker for the intro copy — pick one, then
// hardcode it and delete the picker (variants, IntroPicker, PICKER_CSS).
const INTRO_VARIANTS = [
  {
    label: "Files",
    text: "Plugins write plain markdown straight into your library. No database, no proprietary format — just files you can edit, grep, or move.",
  },
  {
    label: "No lock-in",
    text: "Your archive stays yours: plain markdown on disk, no database, no lock-in. Delete dither tomorrow and everything still reads fine.",
  },
  {
    label: "Search",
    text: "Plugins write markdown into your library and dither indexes it in place — search and sort everything without a second copy.",
  },
  {
    label: "Obsidian",
    text: "Point it at your Obsidian vault and it's indexed in place, searchable alongside plugin-written markdown. No database, no copies.",
  },
  {
    label: "Minimal",
    text: "Markdown in, markdown out — plugin entries and your Obsidian vault, indexed in place. No database, no proprietary format.",
  },
];

const PICKER_CSS = `
.proto-picker-inline {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(10, 10, 10, 0.82);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  backdrop-filter: blur(12px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 8px 24px rgba(0, 0, 0, 0.24),
    0 2px 6px rgba(0, 0, 0, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}
.proto-picker-inline button {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font: inherit;
  cursor: pointer;
  transition: color 150ms ease-out;
}
.proto-picker-inline button:hover { color: rgba(255, 255, 255, 0.85); }
.proto-picker-inline button:active { transform: scale(0.97); }
.proto-picker-inline button[data-active] {
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
}
`;

function IntroPicker({
  active,
  onPick,
}: {
  active: number;
  onPick: (i: number) => void;
}) {
  return (
    <>
      <style>{PICKER_CSS}</style>
      <nav
        className="proto-picker-inline absolute -bottom-6 left-1/2 z-10 -translate-x-1/2"
        aria-label="Intro variants"
      >
        {INTRO_VARIANTS.map((v, i) => (
          <button
            key={v.label}
            type="button"
            data-active={i === active ? "" : undefined}
            aria-current={i === active ? "true" : undefined}
            onClick={() => onPick(i)}
          >
            {v.label}
          </button>
        ))}
      </nav>
    </>
  );
}

export function JustMarkdown() {
  const [intro, setIntro] = useState(0);
  return (
    <section className="relative mt-10 grid grid-cols-1 items-center gap-8 md:grid-cols-[1fr_1.05fr] lg:gap-10">
      <IntroPicker active={intro} onPick={setIntro} />
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          {INTRO_VARIANTS[intro].text}
        </p>
      </div>

      <Terminal className="w-full font-mono text-[12.5px] leading-[20px]">
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
