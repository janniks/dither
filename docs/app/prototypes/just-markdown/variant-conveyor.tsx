"use client";

// Conveyor — cause→effect system view. LEFT: the sandboxed plugin process and
// the narrow set of permissions it was granted. CENTER: data crossing the
// sandbox boundary. RIGHT: the plain markdown file that lands on disk.

import { motion, useReducedMotion } from "motion/react";

const GREEN = "#99D892";
const BLUE = "#4AB5EC";

const GRANTS = ["--allow-net api.raindrop.io", "--env RAINDROP_TOKEN"];

const LOG_LINES = [
  "fetching bookmarks since 2026-05-11",
  "2 new, 0 unchanged",
  "writing raindrop/grug-brained-developer.md",
];

const FILE_LINES: { text: string; tone?: "key" | "delim" | "title" }[] = [
  { text: "---", tone: "delim" },
  { text: "title: The Grug Brained Developer", tone: "key" },
  { text: "url: https://grugbrain.dev", tone: "key" },
  { text: "saved: 2026-05-11", tone: "key" },
  { text: "tags: [engineering, simplicity]", tone: "key" },
  { text: "---", tone: "delim" },
  { text: "" },
  { text: "# The Grug Brained Developer", tone: "title" },
  { text: "" },
  { text: "apex predator of grug is complexity." },
];

export default function VariantConveyor() {
  const reduced = useReducedMotion();

  // Entrance timing: card frames first, then their contents stagger in.
  const ease = [0.16, 1, 0.3, 1] as const;
  const rise = (delay: number) =>
    reduced
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.28, ease, delay },
        };
  const fade = (delay: number) =>
    reduced
      ? { initial: false as const }
      : {
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          transition: { duration: 0.22, ease, delay },
        };

  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Plugins write markdown into your library and dither indexes it in
          place — search and sort everything without a second copy.
        </p>
      </div>

      <div className="grid items-center gap-6 md:grid-cols-[1fr_auto_1.2fr]">
        {/* LEFT — the sandboxed process */}
        <motion.div
          {...rise(0)}
          className="bg-fd-card border-fd-border rounded-lg border p-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[13px] font-medium">raindrop</span>
            <span className="border-fd-border text-fd-muted-foreground rounded-full border px-2 py-[2px] text-[10.5px] tracking-[0.02em]">
              Deno · sandboxed
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {GRANTS.map((grant, i) => (
              <motion.div
                key={grant}
                {...fade(0.12 + i * 0.06)}
                className="border-fd-border bg-fd-muted/40 flex items-center gap-2 rounded border px-2 py-1 font-mono text-[11.5px]"
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: GREEN }}
                />
                <span className="truncate">{grant}</span>
              </motion.div>
            ))}
            <motion.p
              {...fade(0.26)}
              className="text-fd-muted-foreground/70 mt-0.5 font-mono text-[11px]"
            >
              no fs, no shell — everything else denied
            </motion.p>
          </div>

          <div className="border-fd-border mt-3 flex flex-col gap-1 border-t pt-3">
            {LOG_LINES.map((line, i) => (
              <motion.div
                key={line}
                {...fade(0.34 + i * 0.08)}
                className="text-fd-muted-foreground flex items-start gap-2 font-mono text-[11px] leading-[16px]"
              >
                <span
                  aria-hidden
                  className="mt-[5px] size-1 shrink-0 rounded-full"
                  style={{ background: BLUE }}
                />
                <span>{line}</span>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* CENTER — the sandbox boundary, data flowing across it */}
        <motion.div
          {...fade(0.5)}
          aria-hidden
          className="hidden md:flex md:h-24 md:w-16 md:items-center md:justify-center"
        >
          <div className="relative h-px w-full">
            <div className="bg-fd-border absolute inset-0" />
            {!reduced &&
              [0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full"
                  style={{ background: GREEN }}
                  initial={{ x: 0, opacity: 0 }}
                  animate={{ x: 58, opacity: [0, 1, 1, 0] }}
                  transition={{
                    duration: 1.6,
                    delay: 0.6 + i * 0.5,
                    repeat: Infinity,
                    repeatDelay: 0.4,
                    ease: "linear",
                  }}
                />
              ))}
            {reduced && (
              <span
                className="absolute top-1/2 right-0 size-1.5 -translate-y-1/2 rounded-full"
                style={{ background: GREEN }}
              />
            )}
          </div>
        </motion.div>

        {/* RIGHT — the file that lands on disk */}
        <motion.div
          {...rise(0.1)}
          className="bg-fd-card border-fd-border overflow-hidden rounded-lg border"
        >
          <div className="border-fd-border text-fd-muted-foreground flex items-center gap-2 border-b px-4 py-2 font-mono text-[11.5px]">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: BLUE }}
            />
            raindrop/grug-brained-developer.md
          </div>
          <div className="flex flex-col px-4 py-3 font-mono text-[12px] leading-[20px]">
            {FILE_LINES.map((line, i) => (
              <motion.span
                key={i}
                {...fade(0.55 + i * 0.07)}
                className={
                  line.tone === "delim"
                    ? "text-fd-muted-foreground/60"
                    : line.tone === "key"
                      ? "text-fd-muted-foreground"
                      : line.tone === "title"
                        ? "text-fd-foreground font-medium"
                        : "text-fd-foreground"
                }
              >
                {line.text || " "}
              </motion.span>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
