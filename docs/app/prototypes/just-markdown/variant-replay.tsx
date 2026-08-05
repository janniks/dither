"use client";

// Variant: "Replay" — terminal-forward process narrative.
// Heading + one intro line, then an animated replay of a real plugin run:
// typed command → dim JSONL logs → _result → the file tree, where the two
// just-written .md files flash green as they land.

import { useEffect, useState } from "react";
import { Terminal, TypingAnimation, AnimatedSpan } from "@/lib/terminal";

const COMMAND = "$ dither plugin run raindrop";

const LOG_LINES = [
  `{"type":"log","msg":"fetching bookmarks since 2026-05-11"}`,
  `{"type":"log","msg":"2 new, 0 unchanged"}`,
];

const RESULT_LINE = `{"type":"_result","runId":"raindrop-20260803-7f21ab","status":"ok"}`;

const TREE_ROOT = "~/.dither/library";

// [prefix, comment, freshlyWritten]
const TREE_LINES: [string, string | null, boolean][] = [
  ["├── raindrop/", "# just written", false],
  ["│   ├── grug-brained-developer.md", null, true],
  ["│   └── deno-runtime-deep-dive.md", null, true],
  ["├── notes/", "# you write these", false],
  ["└── vault → ~/Documents/Obsidian", "# indexed in place", false],
];

// Pad tree prefixes so the trailing comments line up in the mono column.
const COMMENT_COL = 32;
const pad = (s: string) => s + " ".repeat(Math.max(1, COMMENT_COL - s.length));

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// A tree line that lands green and settles to its resting colour, timed off
// the moment its entrance animation actually starts.
function FreshLine({ text }: { text: string }) {
  const [landed, setLanded] = useState(false);

  return (
    <AnimatedSpan
      className="text-[12.5px]"
      onAnimationStart={() => {
        setLanded(false);
        window.setTimeout(() => setLanded(true), 700);
      }}
    >
      <span
        className={`transition-colors duration-500 ease-out ${
          landed ? "text-fd-foreground" : "text-[#99D892]"
        }`}
      >
        {text}
      </span>
    </AnimatedSpan>
  );
}

export default function VariantReplay() {
  const reduced = useReducedMotion();

  const treeRows = TREE_LINES.map(([prefix, comment, fresh]) => {
    const body = comment ? (
      <>
        {pad(prefix)}
        <span className="text-fd-muted-foreground">{comment}</span>
      </>
    ) : (
      prefix
    );
    return { prefix, comment, fresh, body };
  });

  return (
    <section className="flex flex-col gap-8">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Plugins write plain markdown straight into your library. No database,
          no proprietary format — just files you can edit, grep, or move.
        </p>
      </div>

      {reduced ? (
        // Reduced motion: the same transcript, final state, no sequencing.
        <Terminal
          sequence={false}
          className="mx-auto w-full max-w-xl font-mono text-[12.5px] leading-[20px]"
        >
          <div className="grid gap-y-1">
            <span>{COMMAND}</span>
            {LOG_LINES.map((line) => (
              <span key={line} className="text-fd-muted-foreground">
                {line}
              </span>
            ))}
            <span className="text-fd-muted-foreground">{RESULT_LINE}</span>
            <span className="pt-2">{TREE_ROOT}</span>
            {treeRows.map(({ prefix, fresh, body }) => (
              <span
                key={prefix}
                className={fresh ? "text-[#99D892]" : undefined}
              >
                {body}
              </span>
            ))}
          </div>
        </Terminal>
      ) : (
        <Terminal
          // startOnView={false}: the harness remounts this on switch/replay,
          // so the run must begin immediately rather than wait for scroll.
          startOnView={false}
          className="mx-auto w-full max-w-xl font-mono text-[12.5px] leading-[20px]"
        >
          <TypingAnimation className="text-[12.5px]" startOnView={false}>
            {COMMAND}
          </TypingAnimation>

          {LOG_LINES.map((line) => (
            <AnimatedSpan
              key={line}
              className="text-fd-muted-foreground text-[12.5px]"
            >
              {line}
            </AnimatedSpan>
          ))}

          <AnimatedSpan className="text-fd-muted-foreground text-[12.5px]">
            {RESULT_LINE}
          </AnimatedSpan>

          <AnimatedSpan className="text-[12.5px] pt-2">{TREE_ROOT}</AnimatedSpan>

          {treeRows.map(({ prefix, comment, fresh, body }) =>
            fresh ? (
              <FreshLine key={prefix} text={prefix} />
            ) : (
              <AnimatedSpan key={prefix} className="text-[12.5px]">
                {comment ? body : prefix}
              </AnimatedSpan>
            ),
          )}
        </Terminal>
      )}
    </section>
  );
}
