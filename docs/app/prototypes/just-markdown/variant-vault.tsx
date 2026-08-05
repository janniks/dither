"use client";

// Variant: Vault — artifact-first, editorial. No terminal. A two-pane file
// browser card: slim tree on the left, rendered markdown preview on the right.
// New raindrop files materialize into the tree on mount, preview follows.

import { motion, useReducedMotion } from "motion/react";

const ACCENT_GREEN = "#99D892";

type Row = {
  label: string;
  depth: number;
  kind: "dir" | "file" | "link";
  note?: string;
  fresh?: boolean;
  active?: boolean;
};

const ROWS: Row[] = [
  { label: "~/.dither/library", depth: 0, kind: "dir" },
  { label: "raindrop/", depth: 1, kind: "dir" },
  {
    label: "grug-brained-developer.md",
    depth: 2,
    kind: "file",
    fresh: true,
    active: true,
  },
  { label: "deno-runtime-deep-dive.md", depth: 2, kind: "file", fresh: true },
  { label: "notes/", depth: 1, kind: "dir", note: "you write these" },
  { label: "reading-queue.md", depth: 2, kind: "file" },
  {
    label: "vault → ~/Documents/Obsidian",
    depth: 1,
    kind: "link",
    note: "indexed in place",
  },
];

const FRESH_ORDER = new Map(
  ROWS.filter((r) => r.fresh).map((r, i) => [r.label, i] as const),
);

function DirIcon({ kind }: { kind: Row["kind"] }) {
  if (kind === "dir")
    return <span className="text-fd-muted-foreground/70">▸</span>;
  if (kind === "link")
    return <span className="text-fd-muted-foreground/70">↪</span>;
  return <span className="text-fd-muted-foreground/40">·</span>;
}

export default function VariantVault() {
  const reduced = useReducedMotion();

  const rowMotion = (row: Row) => {
    if (reduced) return {};
    const order = FRESH_ORDER.get(row.label);
    if (order === undefined) return {};
    return {
      initial: { opacity: 0, transform: "translateX(-8px)" },
      animate: { opacity: 1, transform: "translateX(0px)" },
      transition: {
        duration: 0.26,
        ease: [0.16, 1, 0.3, 1] as const,
        delay: 0.15 + order * 0.12,
      },
    };
  };

  const previewMotion = reduced
    ? {}
    : {
        initial: { opacity: 0, transform: "translateY(8px)" },
        animate: { opacity: 1, transform: "translateY(0px)" },
        transition: {
          duration: 0.28,
          ease: [0.16, 1, 0.3, 1] as const,
          delay: 0.46,
        },
      };

  return (
    <section className="flex flex-col gap-8">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Sandboxed plugins write markdown.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Your archive stays yours: plain markdown on disk, no database, no
          lock-in. Delete dither tomorrow and everything still reads fine.
        </p>
      </div>

      <div className="border-fd-border bg-fd-card mx-auto w-full max-w-[880px] overflow-hidden rounded-xl border">
        {/* card header */}
        <div className="border-fd-border text-fd-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11.5px]">
          <span className="bg-fd-muted-foreground/25 size-2 rounded-full" />
          <span className="bg-fd-muted-foreground/25 size-2 rounded-full" />
          <span className="bg-fd-muted-foreground/25 size-2 rounded-full" />
          <span className="ml-2">library</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          {/* left: tree */}
          <div className="border-fd-border bg-fd-muted/30 flex flex-col gap-[3px] border-b p-3 font-mono text-[12px] leading-[20px] sm:border-r sm:border-b-0">
            {ROWS.map((row) => (
              <motion.div
                key={row.label}
                {...rowMotion(row)}
                className={`flex items-center gap-1.5 rounded px-2 py-[3px] ${
                  row.active ? "bg-fd-background" : ""
                }`}
                style={{ paddingLeft: `${8 + row.depth * 12}px` }}
              >
                <DirIcon kind={row.kind} />
                <span
                  className={
                    row.kind === "file"
                      ? "text-fd-foreground truncate"
                      : "text-fd-foreground/80 truncate"
                  }
                >
                  {row.label}
                </span>
                {row.fresh ? (
                  <span
                    className="ml-auto shrink-0 text-[10px] tracking-[0.02em]"
                    style={{ color: ACCENT_GREEN }}
                  >
                    just written
                  </span>
                ) : row.note ? (
                  <span className="text-fd-muted-foreground/70 ml-auto shrink-0 text-[10px]">
                    {row.note}
                  </span>
                ) : null}
              </motion.div>
            ))}
          </div>

          {/* right: rendered document */}
          <motion.div {...previewMotion} className="p-5 sm:p-7">
            <div className="border-fd-border/70 text-fd-muted-foreground mb-5 rounded-md border border-dashed px-3 py-2.5 font-mono text-[11.5px] leading-[19px]">
              <div className="text-fd-muted-foreground/50">---</div>
              <div>
                <span className="text-fd-muted-foreground/60">title: </span>
                &quot;The Grug Brained Developer&quot;
              </div>
              <div>
                <span className="text-fd-muted-foreground/60">url: </span>
                https://grugbrain.dev
              </div>
              <div>
                <span className="text-fd-muted-foreground/60">source: </span>
                raindrop
              </div>
              <div>
                <span className="text-fd-muted-foreground/60">saved: </span>
                2026-08-03
              </div>
              <div className="text-fd-muted-foreground/50">---</div>
            </div>

            <h3
              className="text-fd-foreground text-[26px] leading-[32px] tracking-[-0.01em]"
              style={{ fontFamily: "var(--font-dm-serif)" }}
            >
              The Grug Brained Developer
            </h3>
            <p className="text-fd-muted-foreground mt-3 text-[14.5px] leading-[24px]">
              Grug brain developer not so smart, but grug brain developer program
              many long year and learn some things although mostly still confused.
            </p>
            <p className="text-fd-muted-foreground mt-2.5 text-[14.5px] leading-[24px]">
              Complexity very, very bad. Given choice between complexity or one
              on one against t-rex, grug take t-rex — at least grug see t-rex.
            </p>

            <div className="text-fd-muted-foreground/70 mt-6 font-mono text-[11px]">
              ~/.dither/library/raindrop/grug-brained-developer.md
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
