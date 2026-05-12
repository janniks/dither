"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// Bayer 8x8 — used by several variants to seed dither patterns.
const bayer = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

const bayer4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const bayer2 = [
  [0, 2],
  [3, 1],
];

type Pattern = "8x8" | "4x4" | "2x2" | "random";
type Diagonal = "tl-br" | "tr-bl" | "both";
type EdgesMode = "all" | "horizontal" | "vertical";

type StripOpts = {
  thickness: number;
  cellPx: number;
  falloff: number;
  jitter: number;
  stipple: boolean;
  acrossFalloff: number;
  densityScale: number;
  pattern: Pattern;
  diagonal: Diagonal;
  edges: EdgesMode;
  cardRadius: number;
  buttonRadius: number;
  buttonPill: boolean;
  smartCorners: boolean;
};

const defaultOpts: StripOpts = {
  thickness: 48,
  cellPx: 2,
  falloff: 0.45,
  jitter: 0.2,
  stipple: false,
  acrossFalloff: 1,
  densityScale: 1,
  pattern: "8x8",
  diagonal: "tl-br",
  edges: "all",
  cardRadius: 14,
  buttonRadius: 24,
  buttonPill: true,
  smartCorners: false,
};

const BG = "var(--color-fd-background)";

const sampleCardCopy = (
  <>
    <p className="text-fd-muted-foreground text-[12px] font-semibold tracking-[0.12em] uppercase">
      Manifesto
    </p>
    <p
      className="text-fd-foreground mt-3 text-[14px] leading-[22px]"
      style={{ fontFamily: "var(--font-dm-serif), serif" }}
    >
      Something happened to our digital memories. They used to belong to us.
      Photos on hard drives. Emails in folders. Bookmarks in browsers.
    </p>
  </>
);

const Btn = ({ children = "Try it out now" }: { children?: ReactNode }) => (
  <span className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 px-6 py-3.5 text-[15px] font-semibold no-underline rounded-full">
    {children}
    <ArrowRight size={16} />
  </span>
);

export default function DitherEdgesLab() {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-6 pt-16 pb-24">
      <header>
        <Link
          href="/"
          className="text-fd-muted-foreground text-[13px] no-underline"
        >
          ← back
        </Link>
        <h1 className="mt-4 text-5xl font-[650] leading-none tracking-[-0.05em]">
          dither edges lab
        </h1>
        <p className="text-fd-muted-foreground mt-3 max-w-[640px] text-base">
          Eight techniques to dither the corners of a rectangle. Each variant
          shows the same payload (manifesto card + CTA button) so you can
          compare which approach reads best for both shapes.
        </p>
      </header>

      <Variant n="01" title="CSS radial-gradient mask · smooth fade (baseline)">
        <CardV1 />
        <ButtonV1 />
      </Variant>

      <Variant n="02" title="SVG bayer-dot mask · element punched by dot pattern">
        <CardV2 />
        <ButtonV2 />
      </Variant>

      <Variant n="03" title="Canvas dither overlay · bg-coloured pixels erase corners">
        <CardV3 />
        <ButtonV3 />
      </Variant>

      <Variant n="04" title="Pseudo-element stipple + linear-gradient mask">
        <CardV4 />
        <ButtonV4 />
      </Variant>

      <Variant n="05" title="Inline SVG corner sprite · hand-placed Bayer circles">
        <CardV5 />
        <ButtonV5 />
      </Variant>

      <Variant n="06" title="Dual masks · element clipped + dither bg revealed">
        <CardV6 />
        <ButtonV6 />
      </Variant>

      <Variant n="07" title="Background-image dither via repeating gradient + corner mask">
        <CardV7 />
        <ButtonV7 />
      </Variant>

      <Variant n="08" title="Multi-canvas corner stamps · per-corner low-res buffers">
        <CardV8 />
        <ButtonV8 />
      </Variant>

      <header className="mt-12">
        <h2 className="text-2xl font-[650] tracking-[-0.02em]">
          03 vs 08 — same algorithm, different resolution strategy
        </h2>
        <p className="text-fd-muted-foreground mt-2 max-w-[680px] text-[14px] leading-[22px]">
          Both walk a Bayer 8×8 threshold from the corner inward and stamp
          page-bg-coloured rectangles where coverage beats the threshold —
          the corner appears chewed away.
        </p>
        <ul className="text-fd-muted-foreground mt-3 max-w-[680px] list-disc space-y-1 pl-5 text-[14px] leading-[22px]">
          <li>
            <strong className="text-fd-foreground">03</strong> — canvas
            backing store at <code>devicePixelRatio</code>. Each "cell" is{" "}
            <code>cellPx</code> CSS px, so on retina each cell already maps
            to 2× device pixels. Crisp; reads as a high-resolution stipple.
          </li>
          <li>
            <strong className="text-fd-foreground">08</strong> — canvas
            backing store at low res (one cell = one canvas pixel), then
            CSS-upscaled with <code>image-rendering: pixelated</code>.
            Indifferent to retina; each cell becomes a chunky hard-edged
            block. Reads as 8-bit / retro.
          </li>
        </ul>
      </header>

      <header className="mt-4">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          03 — variations (high-res / dpr-aware)
        </h3>
      </header>

      <SubV3 size={20} cellPx={1} label="03.01 — size 20 · cell 1 (fine, tight)" />
      <SubV3 size={28} cellPx={2} label="03.02 — size 28 · cell 2 (default-ish)" />
      <SubV3 size={36} cellPx={2} label="03.03 — size 36 · cell 2 (slightly bigger)" />
      <SubV3 size={48} cellPx={2} label="03.04 — size 48 · cell 2 (long fade)" />
      <SubV3 size={28} cellPx={3} label="03.05 — size 28 · cell 3 (chunky pixels)" />
      <SubV3 size={40} cellPx={4} label="03.06 — size 40 · cell 4 (very chunky)" />
      <SubV3 size={56} cellPx={2} label="03.07 — size 56 · cell 2 (longest fade)" />
      <SubV3 size={32} cellPx={2} label="03.08 — size 32 · cell 2 (sweet-spot guess)" />

      <header className="mt-4">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          03 — randomized (jittered threshold, asymmetric per corner)
        </h3>
      </header>

      <SubV3 size={36} cellPx={2} jitter={0.1} label="03.r1 — size 36 · cell 2 · jitter 0.10 (subtle)" />
      <SubV3 size={36} cellPx={2} jitter={0.25} label="03.r2 — size 36 · cell 2 · jitter 0.25 (medium)" />
      <SubV3 size={48} cellPx={2} jitter={0.35} label="03.r3 — size 48 · cell 2 · jitter 0.35 (heavy)" />
      <SubV3 size={48} cellPx={3} jitter={0.25} label="03.r4 — size 48 · cell 3 · jitter 0.25 (chunky + random)" />

      <header className="mt-8">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          08 — variations (low-res buffer + CSS pixelated)
        </h3>
      </header>

      <SubV8 size={24} cellPx={2} label="08.01 — size 24 · cell 2 (12 internal cells)" />
      <SubV8 size={32} cellPx={2} label="08.02 — size 32 · cell 2 (16 internal cells)" />
      <SubV8 size={32} cellPx={4} label="08.03 — size 32 · cell 4 (8 internal · chunky)" />
      <SubV8 size={48} cellPx={3} label="08.04 — size 48 · cell 3 (16 internal)" />
      <SubV8 size={48} cellPx={4} label="08.05 — size 48 · cell 4 (12 internal)" />
      <SubV8 size={64} cellPx={4} label="08.06 — size 64 · cell 4 (16 internal · long fade)" />
      <SubV8 size={40} cellPx={5} label="08.07 — size 40 · cell 5 (8 internal · extra chunky)" />
      <SubV8 size={56} cellPx={6} label="08.08 — size 56 · cell 6 (~9 internal · maxi)" />

      <header className="mt-4">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          08 — randomized (jittered threshold, asymmetric per corner)
        </h3>
      </header>

      <SubV8 size={32} cellPx={3} jitter={0.1} label="08.r1 — size 32 · cell 3 · jitter 0.10" />
      <SubV8 size={40} cellPx={3} jitter={0.25} label="08.r2 — size 40 · cell 3 · jitter 0.25" />
      <SubV8 size={48} cellPx={4} jitter={0.3} label="08.r3 — size 48 · cell 4 · jitter 0.30" />
      <SubV8 size={56} cellPx={5} jitter={0.35} label="08.r4 — size 56 · cell 5 · jitter 0.35 (heavy + chunky)" />

      <SubV9Playground />

      <header className="mt-12">
        <h2 className="text-2xl font-[650] tracking-[-0.02em]">
          09 — edge-spanning strips (the "real" creep)
        </h2>
        <p className="text-fd-muted-foreground mt-2 max-w-[680px] text-[14px] leading-[22px]">
          Replaces the small square-canvas-at-the-corner with two strips per
          corner that span the full adjacent edges all the way to the opposite
          corner. Each strip uses ResizeObserver to match its parent's actual
          width/height. Coverage = <code>(1−along)^k · (1−across)</code> — so
          the corner is solid, density falls off along the edge into single
          trickling pixels, and falls off perpendicular into the element body.
          Power <code>k &lt; 1</code> gives a long, gentle tail.
        </p>
      </header>

      <SubV9 thickness={36} cellPx={2} falloff={0.7} jitter={0} label="09.01 — t36 · cell 2 · k 0.7 (linear-ish)" />
      <SubV9 thickness={48} cellPx={2} falloff={0.45} jitter={0} label="09.02 — t48 · cell 2 · k 0.45 (long tail)" />
      <SubV9 thickness={48} cellPx={2} falloff={0.35} jitter={0.2} label="09.03 — t48 · cell 2 · k 0.35 · jitter 0.2 (organic)" />
      <SubV9 thickness={64} cellPx={3} falloff={0.5} jitter={0.25} label="09.04 — t64 · cell 3 · k 0.5 · jitter 0.25 (chunky organic)" />
      <SubV9 thickness={32} cellPx={2} falloff={0.4} jitter={0.35} label="09.05 — t32 · cell 2 · k 0.4 · jitter 0.35 (thin + noisy)" />
      <SubV9 thickness={56} cellPx={3} falloff={0.3} jitter={0.15} label="09.06 — t56 · cell 3 · k 0.3 · jitter 0.15 (very long trickle)" />
      <SubV9 thickness={48} cellPx={4} falloff={0.6} jitter={0.3} label="09.07 — t48 · cell 4 · k 0.6 · jitter 0.3 (retro pixel decay)" />
      <SubV9 thickness={72} cellPx={2} falloff={0.25} jitter={0.4} label="09.08 — t72 · cell 2 · k 0.25 · jitter 0.4 (almost reaches other corner)" />

      <header className="mt-8">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          09 — stipple-only (no solid plateau anywhere)
        </h3>
        <p className="text-fd-muted-foreground mt-2 max-w-[680px] text-[13px] leading-[20px]">
          Coverage uses pure <code>(1−along) · (1−across)</code> — multiplicative —
          so even the corner stipples (some cells fail the Bayer threshold).
          Reads less blocky, more like noise eating the element.
        </p>
      </header>

      <SubV9 thickness={48} cellPx={2} falloff={1} jitter={0} stipple label="09.s1 — t48 · cell 2 · k 1 · stipple (no solid)" />
      <SubV9 thickness={64} cellPx={2} falloff={0.5} jitter={0.2} stipple label="09.s2 — t64 · cell 2 · k 0.5 · jitter 0.2 · stipple" />
      <SubV9 thickness={56} cellPx={3} falloff={0.5} jitter={0.3} stipple label="09.s3 — t56 · cell 3 · k 0.5 · jitter 0.3 · stipple" />
      <SubV9 thickness={72} cellPx={2} falloff={0.4} jitter={0.35} stipple label="09.s4 — t72 · cell 2 · k 0.4 · jitter 0.35 · stipple (long noisy)" />
    </div>
  );
}

function SubV8({
  size,
  cellPx,
  label,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  label: string;
  jitter?: number;
}) {
  const btnSize = Math.max(16, Math.round(size * 0.6));
  const btnCell = Math.max(2, Math.min(cellPx, 4));
  return (
    <section className="border bg-fd-card flex flex-col gap-4 rounded-[20px] p-6">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{label}</h3>
      <div className="bg-fd-background grid grid-cols-1 items-center gap-6 rounded-[16px] p-8 sm:grid-cols-[1.4fr_1fr]">
        <CardEaterLowRes size={size} cellPx={cellPx} jitter={jitter} />
        <ButtonEaterLowRes size={btnSize} cellPx={btnCell} jitter={jitter} />
      </div>
    </section>
  );
}

function CardEaterLowRes({
  size,
  cellPx,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  return (
    <div className="bg-fd-card relative max-w-[440px] overflow-hidden rounded-[14px]">
      <div className="relative z-[1] p-6">{sampleCardCopy}</div>
      <CornerEraserLowRes position="tl" size={size} cellPx={cellPx} jitter={jitter} />
      <CornerEraserLowRes position="br" size={size} cellPx={cellPx} jitter={jitter} />
    </div>
  );
}

function ButtonEaterLowRes({
  size,
  cellPx,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  return (
    <span className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden rounded-full px-6 py-3.5 text-[15px] font-semibold">
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <CornerEraserLowRes position="tl" size={size} cellPx={cellPx} jitter={jitter} />
      <CornerEraserLowRes position="br" size={size} cellPx={cellPx} jitter={jitter} />
    </span>
  );
}

// Low-res buffer (one cell = one canvas pixel) + CSS upscale with
// image-rendering: pixelated → chunky retro look, dpr-independent.
// Stable per-corner-per-cell pseudo-random in [-0.5, 0.5]. Hashing keeps each
// corner deterministically different on every render (no twitch on remount)
// while still breaking 4-way symmetry.
function jitterFor(position: string, cx: number, cy: number): number {
  let h = position.charCodeAt(0) * 73856093 + cx * 19349663 + cy * 83492791;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h ^= h >>> 16;
  return (((h >>> 0) % 1024) / 1023 - 0.5);
}

// ── 09 — edge-spanning strips ─────────────────────────────────────────────

function SubV9Playground() {
  const [opts, setOpts] = useState<StripOpts>(defaultOpts);
  const set = <K extends keyof StripOpts>(k: K) => (v: StripOpts[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  return (
    <section className="border bg-fd-card flex flex-col gap-5 rounded-[20px] p-6">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">
          09 — live playground
        </h2>
        <p className="text-fd-muted-foreground mt-1 text-[13px]">
          Tune every axis live. Coverage formula:{" "}
          <code>(1−along)^(1/k) · (1−across)^(1/k_across) · densityScale</code>{" "}
          — Bayer threshold + jitter on top.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Slider
          label="thickness"
          value={opts.thickness}
          min={16}
          max={160}
          step={4}
          unit="px"
          onChange={set("thickness")}
        />
        <Slider
          label="cellPx"
          value={opts.cellPx}
          min={1}
          max={8}
          step={1}
          unit="px"
          onChange={set("cellPx")}
        />
        <Slider
          label="falloff along (k)"
          value={opts.falloff}
          min={0.15}
          max={2}
          step={0.05}
          onChange={set("falloff")}
        />
        <Slider
          label="falloff across (k)"
          value={opts.acrossFalloff}
          min={0.15}
          max={2}
          step={0.05}
          onChange={set("acrossFalloff")}
        />
        <Slider
          label="jitter"
          value={opts.jitter}
          min={0}
          max={0.6}
          step={0.05}
          onChange={set("jitter")}
        />
        <Slider
          label="density scale"
          value={opts.densityScale}
          min={0.4}
          max={1.6}
          step={0.05}
          onChange={set("densityScale")}
        />
        <Select
          label="pattern"
          value={opts.pattern}
          options={["8x8", "4x4", "2x2", "random"]}
          onChange={set("pattern")}
        />
        <Select
          label="diagonal"
          value={opts.diagonal}
          options={["tl-br", "tr-bl", "both"]}
          onChange={set("diagonal")}
        />
        <Select
          label="edges"
          value={opts.edges}
          options={["all", "horizontal", "vertical"]}
          onChange={set("edges")}
        />
        <label className="flex flex-col gap-2">
          <span className="text-fd-muted-foreground text-[12px] font-medium">
            stipple (no solid plateau)
          </span>
          <span className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!opts.stipple}
              onChange={(e) => set("stipple")(e.target.checked)}
              className="accent-fd-primary size-4"
            />
            <span className="text-fd-foreground text-[13px] font-mono">
              {opts.stipple ? "on" : "off"}
            </span>
          </span>
        </label>
        <Slider
          label="card radius"
          value={opts.cardRadius}
          min={0}
          max={32}
          step={1}
          unit="px"
          onChange={set("cardRadius")}
        />
        <Slider
          label="button radius"
          value={opts.buttonRadius}
          min={0}
          max={32}
          step={1}
          unit="px"
          onChange={set("buttonRadius")}
        />
        <label className="flex flex-col gap-2">
          <span className="text-fd-muted-foreground text-[12px] font-medium">
            button pill (overrides radius)
          </span>
          <span className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!opts.buttonPill}
              onChange={(e) => set("buttonPill")(e.target.checked)}
              className="accent-fd-primary size-4"
            />
            <span className="text-fd-foreground text-[13px] font-mono">
              {opts.buttonPill ? "pill" : "uses radius"}
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-fd-muted-foreground text-[12px] font-medium">
            smart corners (only round non-dithered)
          </span>
          <span className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!opts.smartCorners}
              onChange={(e) => set("smartCorners")(e.target.checked)}
              className="accent-fd-primary size-4"
            />
            <span className="text-fd-foreground text-[13px] font-mono">
              {opts.smartCorners ? "smart" : "uniform"}
            </span>
          </span>
        </label>
      </div>

      <div className="bg-fd-background grid grid-cols-1 items-center gap-6 rounded-[16px] p-8 sm:grid-cols-[1.4fr_1fr]">
        <CardStrip
          {...opts}
        />
        <ButtonStrip
          {...opts}
          thickness={Math.min(opts.thickness, 24)}
          cellPx={Math.min(opts.cellPx, 3)}
        />
      </div>

      <pre className="bg-fd-muted/40 text-fd-muted-foreground overflow-auto rounded-[8px] p-3 text-[12px]">
        <code>
          {`thickness=${opts.thickness} cellPx=${opts.cellPx} falloff=${opts.falloff.toFixed(2)} acrossFalloff=${opts.acrossFalloff.toFixed(2)} jitter=${opts.jitter.toFixed(2)} densityScale=${opts.densityScale.toFixed(2)} pattern=${opts.pattern} diagonal=${opts.diagonal} edges=${opts.edges} stipple=${opts.stipple} cardRadius=${opts.cardRadius} buttonRadius=${opts.buttonRadius} buttonPill=${opts.buttonPill} smartCorners=${opts.smartCorners}`}
        </code>
      </pre>
    </section>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-fd-muted-foreground text-[12px] font-medium">
        {label}
      </span>
      <select
        value={value ?? options[0]}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-fd-background border-fd-border text-fd-foreground rounded-md border px-2 py-1.5 text-[13px] font-mono"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-fd-muted-foreground inline-flex items-center justify-between text-[12px] font-medium">
        <span>{label}</span>
        <span className="text-fd-foreground font-mono">
          {Number.isInteger(step) ? value : value.toFixed(2)}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-fd-primary w-full"
      />
    </label>
  );
}

function SubV9({
  thickness,
  cellPx,
  falloff,
  jitter = 0,
  stipple = false,
  label,
}: {
  thickness: number;
  cellPx: number;
  falloff: number;
  jitter?: number;
  stipple?: boolean;
  label: string;
}) {
  const opts: StripOpts = {
    ...defaultOpts,
    thickness,
    cellPx,
    falloff,
    jitter,
    stipple,
  };
  return (
    <section className="border bg-fd-card flex flex-col gap-4 rounded-[20px] p-6">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{label}</h3>
      <div className="bg-fd-background grid grid-cols-1 items-center gap-6 rounded-[16px] p-8 sm:grid-cols-[1.4fr_1fr]">
        <CardStrip {...opts} />
        <ButtonStrip
          {...opts}
          thickness={Math.min(thickness, 24)}
          cellPx={Math.min(cellPx, 3)}
        />
      </div>
    </section>
  );
}

function stripsFor(diagonal: Diagonal, edges: EdgesMode) {
  const horiz = edges !== "vertical";
  const vert = edges !== "horizontal";
  const list: { edge: "top" | "bottom" | "left" | "right"; origin: 0 | 1; key: string }[] = [];
  const wantTL = diagonal === "tl-br" || diagonal === "both";
  const wantBR = diagonal === "tl-br" || diagonal === "both";
  const wantTR = diagonal === "tr-bl" || diagonal === "both";
  const wantBL = diagonal === "tr-bl" || diagonal === "both";
  if (wantTL) {
    if (horiz) list.push({ edge: "top", origin: 0, key: "tl-top" });
    if (vert) list.push({ edge: "left", origin: 0, key: "tl-left" });
  }
  if (wantBR) {
    if (horiz) list.push({ edge: "bottom", origin: 1, key: "br-bottom" });
    if (vert) list.push({ edge: "right", origin: 1, key: "br-right" });
  }
  if (wantTR) {
    if (horiz) list.push({ edge: "top", origin: 1, key: "tr-top" });
    if (vert) list.push({ edge: "right", origin: 0, key: "tr-right" });
  }
  if (wantBL) {
    if (horiz) list.push({ edge: "bottom", origin: 0, key: "bl-bottom" });
    if (vert) list.push({ edge: "left", origin: 1, key: "bl-left" });
  }
  return list;
}

function cornerActiveMap(diagonal: Diagonal) {
  return {
    tl: diagonal === "tl-br" || diagonal === "both",
    tr: diagonal === "tr-bl" || diagonal === "both",
    bl: diagonal === "tr-bl" || diagonal === "both",
    br: diagonal === "tl-br" || diagonal === "both",
  };
}

function radiusFor(opts: StripOpts, base: number) {
  const active = cornerActiveMap(opts.diagonal);
  const r = (corner: "tl" | "tr" | "bl" | "br") =>
    opts.smartCorners && active[corner] ? 0 : base;
  return {
    borderTopLeftRadius: r("tl"),
    borderTopRightRadius: r("tr"),
    borderBottomLeftRadius: r("bl"),
    borderBottomRightRadius: r("br"),
  };
}

function CardStrip(opts: StripOpts) {
  return (
    <div
      className="bg-fd-card relative max-w-[440px] overflow-hidden"
      style={radiusFor(opts, opts.cardRadius)}
    >
      <div className="relative z-[1] p-6">{sampleCardCopy}</div>
      {stripsFor(opts.diagonal, opts.edges).map((s) => (
        <EdgeStrip key={s.key} edge={s.edge} origin={s.origin} {...opts} />
      ))}
    </div>
  );
}

function ButtonStrip(opts: StripOpts) {
  // Pill toggle overrides the per-corner slider with a huge radius. Smart
  // corners then zeroes out only the dithered diagonal on top of that.
  const base = opts.buttonPill ? 9999 : opts.buttonRadius;
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden px-6 py-3.5 text-[15px] font-semibold"
      style={radiusFor(opts, base)}
    >
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      {stripsFor(opts.diagonal, opts.edges).map((s) => (
        <EdgeStrip key={s.key} edge={s.edge} origin={s.origin} {...opts} />
      ))}
    </span>
  );
}

// Strip dither: spans the full adjacent edge length (ResizeObserver-driven),
// with a power-curve falloff along the edge and a configurable perpendicular
// falloff. `origin` picks which end of the strip is the dense corner.
function EdgeStrip({
  edge,
  origin,
  thickness,
  cellPx,
  falloff,
  jitter,
  stipple,
  acrossFalloff,
  densityScale,
  pattern,
}: StripOpts & {
  edge: "top" | "bottom" | "left" | "right";
  origin: 0 | 1;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const parent = c.parentElement;
    if (!parent) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const rect = parent.getBoundingClientRect();
      const isHorizontal = edge === "top" || edge === "bottom";
      const lengthPx = isHorizontal ? rect.width : rect.height;
      if (lengthPx < 2) return;
      const cellsAlong = Math.max(2, Math.round(lengthPx / cellPx));
      const cellsAcross = Math.max(2, Math.round(thickness / cellPx));

      const w = isHorizontal ? cellsAlong : cellsAcross;
      const h = isHorizontal ? cellsAcross : cellsAlong;
      c.width = w;
      c.height = h;
      c.style.width = (isHorizontal ? lengthPx : thickness) + "px";
      c.style.height = (isHorizontal ? thickness : lengthPx) + "px";

      const styles = getComputedStyle(document.documentElement);
      ctx.fillStyle =
        styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a";
      ctx.clearRect(0, 0, w, h);

      const safeFalloff = Math.max(0.1, falloff);
      const safeAcross = Math.max(0.1, acrossFalloff);

      const threshold = (cx: number, cy: number): number => {
        if (pattern === "2x2") return (bayer2[cy & 1][cx & 1] + 0.5) / 4;
        if (pattern === "4x4") return (bayer4[cy & 3][cx & 3] + 0.5) / 16;
        if (pattern === "random")
          return 0.5 + jitterFor("rng-" + edge + origin, cx, cy);
        return (bayer[cy & 7][cx & 7] + 0.5) / 64;
      };

      for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++) {
          let along: number, across: number;
          if (isHorizontal) {
            along = cx / (w - 1);
            across = cy / (h - 1);
            if (edge === "bottom") across = 1 - across;
          } else {
            along = cy / (h - 1);
            across = cx / (w - 1);
            if (edge === "right") across = 1 - across;
          }
          if (origin === 1) along = 1 - along;

          const alongFactor = Math.pow(Math.max(0, 1 - along), 1 / safeFalloff);
          const acrossFactor = Math.pow(
            Math.max(0, 1 - across),
            1 / safeAcross,
          );
          const baseCoverage = alongFactor * acrossFactor;
          const coverage =
            (stipple ? baseCoverage * 0.9 : baseCoverage) * densityScale;
          const t =
            threshold(cx, cy) + jitter * jitterFor(edge + origin, cx, cy);
          if (coverage > t) ctx.fillRect(cx, cy, 1, 1);
        }
      }
    };

    render();
    const obs = new ResizeObserver(render);
    obs.observe(parent);
    return () => obs.disconnect();
  }, [
    edge,
    origin,
    thickness,
    cellPx,
    falloff,
    jitter,
    stipple,
    acrossFalloff,
    densityScale,
    pattern,
  ]);

  const positionStyle: CSSProperties = (() => {
    switch (edge) {
      case "top":
        return { top: 0, left: 0, right: 0 };
      case "bottom":
        return { bottom: 0, left: 0, right: 0 };
      case "left":
        return { top: 0, bottom: 0, left: 0 };
      case "right":
        return { top: 0, bottom: 0, right: 0 };
    }
  })();

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{
        ...positionStyle,
        imageRendering: "pixelated",
      }}
    />
  );
}

function CornerEraserLowRes({
  position,
  size,
  cellPx,
  jitter = 0,
}: {
  position: "tl" | "tr" | "bl" | "br";
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const cells = Math.max(2, Math.round(size / cellPx));
    c.width = cells;
    c.height = cells;
    c.style.width = size + "px";
    c.style.height = size + "px";
    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle =
      styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a";
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        let nx = cx / (cells - 1);
        let ny = cy / (cells - 1);
        if (position === "tr") nx = 1 - nx;
        if (position === "bl") ny = 1 - ny;
        if (position === "br") {
          nx = 1 - nx;
          ny = 1 - ny;
        }
        const dist = Math.min(1, Math.min(nx, ny) * 2 + Math.max(nx, ny) * 0.4);
        const coverage = Math.max(0, 1 - dist);
        const t =
          (bayer[cy & 7][cx & 7] + 0.5) / 64 +
          jitter * jitterFor(position, cx, cy);
        if (coverage > t) ctx.fillRect(cx, cy, 1, 1);
      }
    }
  }, [position, size, cellPx, jitter]);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{
        ...(position.includes("t") ? { top: 0 } : { bottom: 0 }),
        ...(position.includes("l") ? { left: 0 } : { right: 0 }),
        imageRendering: "pixelated",
      }}
    />
  );
}

function SubV3({
  size,
  cellPx,
  label,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  label: string;
  jitter?: number;
}) {
  // Smaller corner for the button so it doesn't overpower the wordmark.
  const btnSize = Math.max(16, Math.round(size * 0.75));
  const btnCell = Math.max(1, Math.min(cellPx, 2));
  return (
    <section className="border bg-fd-card flex flex-col gap-4 rounded-[20px] p-6">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{label}</h3>
      <div className="bg-fd-background grid grid-cols-1 items-center gap-6 rounded-[16px] p-8 sm:grid-cols-[1.4fr_1fr]">
        <CardEater size={size} cellPx={cellPx} jitter={jitter} />
        <ButtonEater size={btnSize} cellPx={btnCell} jitter={jitter} />
      </div>
    </section>
  );
}

// Card with corner-canvas erasers; text sits above the canvases via z-index.
function CardEater({
  size,
  cellPx,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  return (
    <div className="bg-fd-card relative max-w-[440px] overflow-hidden rounded-[14px]">
      <div className="relative z-[1] p-6">{sampleCardCopy}</div>
      <CornerEraserPrecise position="tl" size={size} cellPx={cellPx} jitter={jitter} />
      <CornerEraserPrecise position="br" size={size} cellPx={cellPx} jitter={jitter} />
    </div>
  );
}

function ButtonEater({
  size,
  cellPx,
  jitter = 0,
}: {
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  return (
    <span className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden rounded-full px-6 py-3.5 text-[15px] font-semibold">
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <CornerEraserPrecise position="tl" size={size} cellPx={cellPx} jitter={jitter} />
      <CornerEraserPrecise position="br" size={size} cellPx={cellPx} jitter={jitter} />
    </span>
  );
}

// DPR-aware: backing store at size * devicePixelRatio, cells are filled at
// CSS-pixel coordinates (each cell becomes cellPx * dpr device pixels).
function CornerEraserPrecise({
  position,
  size,
  cellPx,
  jitter = 0,
}: {
  position: "tl" | "tr" | "bl" | "br";
  size: number;
  cellPx: number;
  jitter?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(size * dpr);
    c.height = Math.ceil(size * dpr);
    c.style.width = size + "px";
    c.style.height = size + "px";
    ctx.scale(dpr, dpr);
    const cells = Math.max(2, Math.round(size / cellPx));
    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle =
      styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a";
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        let nx = cx / (cells - 1);
        let ny = cy / (cells - 1);
        if (position === "tr") nx = 1 - nx;
        if (position === "bl") ny = 1 - ny;
        if (position === "br") {
          nx = 1 - nx;
          ny = 1 - ny;
        }
        const dist = Math.min(1, Math.min(nx, ny) * 2 + Math.max(nx, ny) * 0.4);
        const coverage = Math.max(0, 1 - dist);
        const t =
          (bayer[cy & 7][cx & 7] + 0.5) / 64 +
          jitter * jitterFor(position, cx, cy);
        if (coverage > t) ctx.fillRect(cx * cellPx, cy * cellPx, cellPx, cellPx);
      }
    }
  }, [position, size, cellPx, jitter]);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{
        ...(position.includes("t") ? { top: 0 } : { bottom: 0 }),
        ...(position.includes("l") ? { left: 0 } : { right: 0 }),
        imageRendering: "pixelated",
      }}
    />
  );
}

function Variant({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border bg-fd-card flex flex-col gap-5 rounded-[20px] p-6">
      <div>
        <span className="text-fd-muted-foreground text-[12px] font-semibold tracking-[0.08em]">
          {n}
        </span>
        <h2 className="mt-1 text-[17px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
      </div>
      <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[1.4fr_1fr]">
        {children}
      </div>
    </section>
  );
}

// ---------- 01 — radial-gradient mask (smooth, NOT dithered; baseline) ----------

const v1Mask: CSSProperties = {
  WebkitMaskImage:
    "radial-gradient(circle at 0% 0%, transparent 0, black 28px), radial-gradient(circle at 100% 100%, transparent 0, black 28px)",
  maskImage:
    "radial-gradient(circle at 0% 0%, transparent 0, black 28px), radial-gradient(circle at 100% 100%, transparent 0, black 28px)",
  WebkitMaskComposite: "source-in",
  maskComposite: "intersect",
};

function CardV1() {
  return (
    <div className="bg-fd-card max-w-[440px] p-6" style={v1Mask}>
      {sampleCardCopy}
    </div>
  );
}
function ButtonV1() {
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 px-6 py-3.5 text-[15px] font-semibold"
      style={v1Mask}
    >
      Try it out now
      <ArrowRight size={16} />
    </span>
  );
}

// ---------- 02 — SVG bayer-dot mask (denser dots toward corner) ----------

function BayerDotMask({
  density = 0.55,
  size = 4,
}: {
  density?: number;
  size?: number;
}) {
  // Build a tiled SVG mask once. White circles are opaque (kept), black bg dropped.
  const cells: ReactNode[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const t = (bayer[y][x] + 0.5) / 64;
      if (t < density) {
        cells.push(
          <rect
            key={`${x}-${y}`}
            x={x * size}
            y={y * size}
            width={size}
            height={size}
            fill="white"
          />,
        );
      }
    }
  }
  const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${8 * size}" height="${8 * size}"><rect width="100%" height="100%" fill="black"/>${cells
    .map(
      (_, i) => {
        const idx = i;
        const y = Math.floor(idx / 8);
        const x = idx % 8;
        // dummy — we'll rebuild from cells positions below
        void x;
        void y;
        return "";
      },
    )
    .join("")}</svg>`;
  // simpler: just return cells; React will render the actual <svg>
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        <mask id="bayer-dot-mask">
          <rect width="100%" height="100%" fill="black" />
          {cells}
        </mask>
      </defs>
    </svg>
  );
  void svgString;
}

// Variant 02 uses CSS `mask-image: url(svg)` with bayer pattern that fades at corners
function bayerMaskCss(): CSSProperties {
  // Build a small SVG: 64x64 box of 4px dither cells with radial alpha falloff at one corner.
  // Pixels where (bayer threshold) < (radial distance) are kept opaque.
  const size = 4;
  const w = 8 * size;
  const cells: string[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      // distance from top-left corner, normalized 0..1
      const dx = x / 7;
      const dy = y / 7;
      const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
      const threshold = (bayer[y][x] + 0.5) / 64;
      const alpha = dist > threshold ? 1 : 0;
      if (alpha) {
        cells.push(
          `<rect x="${x * size}" y="${y * size}" width="${size}" height="${size}" fill="white"/>`,
        );
      }
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'><rect width='100%' height='100%' fill='black'/>${cells.join("")}</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return {
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskRepeat: "repeat",
    maskRepeat: "repeat",
    WebkitMaskSize: `${w}px ${w}px`,
    maskSize: `${w}px ${w}px`,
  };
}

function CardV2() {
  return (
    <div
      className="bg-fd-card max-w-[440px] p-6"
      style={bayerMaskCss()}
    >
      {sampleCardCopy}
    </div>
  );
}
function ButtonV2() {
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 px-6 py-3.5 text-[15px] font-semibold"
      style={bayerMaskCss()}
    >
      Try it out now
      <ArrowRight size={16} />
    </span>
  );
}

// ---------- 03 — Canvas dither overlay (bg-coloured pixels punch corners) ----------

function CornerEraser({
  position,
  size = 96,
  cellPx = 3,
}: {
  position: "tl" | "tr" | "bl" | "br";
  size?: number;
  cellPx?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const px = size;
    c.width = px * dpr;
    c.height = px * dpr;
    c.style.width = px + "px";
    c.style.height = px + "px";
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a";
    ctx.fillStyle = bg;
    ctx.scale(dpr, dpr);
    const cell = cellPx;
    const cells = Math.ceil(px / cell);
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        // distance from the chosen corner, in cell units, normalized to [0..1].
        let nx = cx / (cells - 1);
        let ny = cy / (cells - 1);
        if (position === "tr") nx = 1 - nx;
        if (position === "bl") ny = 1 - ny;
        if (position === "br") {
          nx = 1 - nx;
          ny = 1 - ny;
        }
        const dist = Math.min(1, Math.min(nx, ny) * 2 + Math.max(nx, ny) * 0.4);
        // Closer to the corner → more bg-coloured pixels (greater coverage).
        const coverage = Math.max(0, 1 - dist);
        const t = (bayer[cy & 7][cx & 7] + 0.5) / 64;
        if (coverage > t) {
          ctx.fillRect(cx * cell, cy * cell, cell, cell);
        }
      }
    }
  }, [position, size, cellPx]);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{
        ...(position.includes("t") ? { top: 0 } : { bottom: 0 }),
        ...(position.includes("l") ? { left: 0 } : { right: 0 }),
        imageRendering: "pixelated",
      }}
    />
  );
}

function CardV3() {
  return (
    <div className="bg-fd-card relative max-w-[440px] overflow-hidden rounded-[14px] p-6">
      {sampleCardCopy}
      <CornerEraser position="tl" />
      <CornerEraser position="br" />
    </div>
  );
}
function ButtonV3() {
  return (
    <span className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden rounded-full px-6 py-3.5 text-[15px] font-semibold">
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <CornerEraser position="tl" size={32} cellPx={2} />
      <CornerEraser position="br" size={32} cellPx={2} />
    </span>
  );
}

// ---------- 04 — Pseudo-stipple with linear gradient mask ----------

const v4Style: CSSProperties = {
  // Tiny dot stipple as a tiled background-image, faded out toward centre
  // via mask. Reads as a dithered noise frame.
  position: "relative",
};

function StippleFrame() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          "radial-gradient(currentColor 0.7px, transparent 0.7px)",
        backgroundSize: "3px 3px",
        color: BG,
        WebkitMaskImage:
          "radial-gradient(ellipse at center, transparent 40%, black 95%)",
        maskImage:
          "radial-gradient(ellipse at center, transparent 40%, black 95%)",
      }}
    />
  );
}

function CardV4() {
  return (
    <div
      className="bg-fd-card max-w-[440px] rounded-[14px] p-6"
      style={v4Style}
    >
      {sampleCardCopy}
      <StippleFrame />
    </div>
  );
}
function ButtonV4() {
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-semibold"
      style={v4Style}
    >
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <StippleFrame />
    </span>
  );
}

// ---------- 05 — Inline SVG corner sprite with hand-placed Bayer circles ----------

function BayerCornerSprite({
  position,
  size = 56,
  dot = 2.5,
}: {
  position: "tl" | "tr" | "bl" | "br";
  size?: number;
  dot?: number;
}) {
  // 8x8 grid of dots, denser toward the corner. Page bg colour.
  const cells = 8;
  const cellPx = size / cells;
  const dots: ReactNode[] = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      let nx = x / (cells - 1);
      let ny = y / (cells - 1);
      if (position === "tr") nx = 1 - nx;
      if (position === "bl") ny = 1 - ny;
      if (position === "br") {
        nx = 1 - nx;
        ny = 1 - ny;
      }
      const dist = Math.min(1, Math.min(nx, ny) * 2 + Math.max(nx, ny) * 0.4);
      const coverage = Math.max(0, 1 - dist);
      const t = (bayer[y][x] + 0.5) / 64;
      if (coverage > t) {
        dots.push(
          <circle
            key={`${x}-${y}`}
            cx={x * cellPx + cellPx / 2}
            cy={y * cellPx + cellPx / 2}
            r={dot}
            fill={BG}
          />,
        );
      }
    }
  }
  const positionStyle: CSSProperties = {
    position: "absolute",
    ...(position.includes("t") ? { top: 0 } : { bottom: 0 }),
    ...(position.includes("l") ? { left: 0 } : { right: 0 }),
    pointerEvents: "none",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={positionStyle}
      aria-hidden
    >
      {dots}
    </svg>
  );
}

function CardV5() {
  return (
    <div className="bg-fd-card relative max-w-[440px] rounded-[14px] p-6">
      {sampleCardCopy}
      <BayerCornerSprite position="tl" />
      <BayerCornerSprite position="br" />
    </div>
  );
}
function ButtonV5() {
  return (
    <span className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-semibold">
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <BayerCornerSprite position="tl" size={26} dot={1.2} />
      <BayerCornerSprite position="br" size={26} dot={1.2} />
    </span>
  );
}

// ---------- 06 — Dual masks: element clipped to bayer + bg pattern reveal ----------

// Same effective look as v2, but the element itself is alpha-masked (no overlay).
// This variant uses `mask-mode: alpha` explicitly via PNG-style data URI.
function cornerAlphaMask(): CSSProperties {
  const size = 5;
  const w = 64;
  const cells = Math.floor(w / size);
  const rects: string[] = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      // distance from nearest corner (any of 4) → smaller dist = more transparent
      const cx = x / (cells - 1);
      const cy = y / (cells - 1);
      const dx = Math.min(cx, 1 - cx);
      const dy = Math.min(cy, 1 - cy);
      const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.5);
      const t = (bayer[y & 7][x & 7] + 0.5) / 64;
      const opaque = dist > 1 - t;
      if (opaque) {
        rects.push(
          `<rect x='${x * size}' y='${y * size}' width='${size}' height='${size}' fill='white'/>`,
        );
      }
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'><rect width='100%' height='100%' fill='black'/>${rects.join("")}</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return {
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

function CardV6() {
  return (
    <div
      className="bg-fd-card max-w-[440px] p-6"
      style={cornerAlphaMask()}
    >
      {sampleCardCopy}
    </div>
  );
}
function ButtonV6() {
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 px-6 py-3.5 text-[15px] font-semibold"
      style={cornerAlphaMask()}
    >
      Try it out now
      <ArrowRight size={16} />
    </span>
  );
}

// ---------- 07 — Repeating-gradient stipple background + radial corner mask ----------

const v7Style: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, currentColor 1px, transparent 1.1px)",
  backgroundSize: "4px 4px",
  // Mask covers the centre fully, falls off into transparency at the corners.
  WebkitMaskImage:
    "radial-gradient(ellipse 90% 70% at center, black 60%, transparent 100%)",
  maskImage:
    "radial-gradient(ellipse 90% 70% at center, black 60%, transparent 100%)",
};

function CardV7() {
  return (
    <div
      className="bg-fd-card max-w-[440px] p-6 text-fd-foreground"
      style={v7Style}
    >
      {sampleCardCopy}
    </div>
  );
}
function ButtonV7() {
  return (
    <span
      className="bg-fd-primary text-fd-primary-foreground inline-flex items-center gap-2 px-6 py-3.5 text-[15px] font-semibold"
      style={v7Style}
    >
      Try it out now
      <ArrowRight size={16} />
    </span>
  );
}

// ---------- 08 — Per-corner low-res canvas stamps, baked once via SVG <foreignObject>-free path ----------

function CornerCanvas({
  position,
  size = 80,
  cellPx = 2,
  color = BG,
}: {
  position: "tl" | "tr" | "bl" | "br";
  size?: number;
  cellPx?: number;
  color?: string;
}) {
  // Like v3 but renders the canvas at half-res and CSS-scales it 2x for chunkier pixels.
  const ref = useRef<HTMLCanvasElement>(null);
  const idForLog = useId();
  void idForLog;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const internal = Math.ceil(size / cellPx);
    c.width = internal;
    c.height = internal;
    c.style.width = size + "px";
    c.style.height = size + "px";
    const styles = getComputedStyle(document.documentElement);
    const resolved =
      color === BG
        ? styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a"
        : color;
    ctx.fillStyle = resolved;
    for (let cy = 0; cy < internal; cy++) {
      for (let cx = 0; cx < internal; cx++) {
        let nx = cx / (internal - 1);
        let ny = cy / (internal - 1);
        if (position === "tr") nx = 1 - nx;
        if (position === "bl") ny = 1 - ny;
        if (position === "br") {
          nx = 1 - nx;
          ny = 1 - ny;
        }
        const dist = Math.min(1, Math.min(nx, ny) * 2 + Math.max(nx, ny) * 0.4);
        const coverage = Math.max(0, 1 - dist);
        const t = (bayer[cy & 7][cx & 7] + 0.5) / 64;
        if (coverage > t) {
          ctx.fillRect(cx, cy, 1, 1);
        }
      }
    }
  }, [position, size, cellPx, color]);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{
        ...(position.includes("t") ? { top: 0 } : { bottom: 0 }),
        ...(position.includes("l") ? { left: 0 } : { right: 0 }),
        imageRendering: "pixelated",
      }}
    />
  );
}

function CardV8() {
  return (
    <div className="bg-fd-card relative max-w-[440px] overflow-hidden rounded-[14px] p-6">
      {sampleCardCopy}
      <CornerCanvas position="tl" />
      <CornerCanvas position="br" />
    </div>
  );
}
function ButtonV8() {
  return (
    <span className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden rounded-full px-6 py-3.5 text-[15px] font-semibold">
      <span className="relative z-[1] inline-flex items-center gap-2">
        Try it out now
        <ArrowRight size={16} />
      </span>
      <CornerCanvas position="tl" size={28} cellPx={2} />
      <CornerCanvas position="br" size={28} cellPx={2} />
    </span>
  );
}

// keep these in scope even though Btn / BayerDotMask aren't used everywhere yet
void Btn;
void BayerDotMask;
