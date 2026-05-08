"use client";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Dithering } from "@paper-design/shaders-react";
import { useRef, useState } from "react";
import { DitherCanvas } from "@/lib/dither-canvas";
import { DitherCanvasStopping } from "@/lib/dither-canvas-stopping";
import { DitherCanvasHover } from "@/lib/dither-canvas-hover";
import Dither from "./Dither";

type Tone = "light" | "dark";

const surface: Record<Tone, { bg: string; sub: string; fg: string; muted: string }> = {
  light: { bg: "#f5f5f5", sub: "#ffffff", fg: "#0a0a0a", muted: "#999" },
  dark: { bg: "#0a0a0a", sub: "#171717", fg: "#f5f5f5", muted: "#666" },
};

const overlay = (size: number, weight = 600): CSSProperties => ({
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "white",
  fontSize: size,
  fontWeight: weight,
  letterSpacing: "-0.05em",
  pointerEvents: "none",
  textShadow: "0 1px 2px rgba(0,0,0,0.45)",
});

const mark = (size: number, tone: Tone = "light"): CSSProperties => ({
  fontSize: size,
  fontWeight: 650,
  letterSpacing: "-0.05em",
  color: surface[tone].fg,
  lineHeight: 1,
});

function Variant({
  n,
  title,
  desc,
  children,
}: {
  n: number;
  title: string;
  desc: string;
  children: (tone: Tone) => ReactNode;
}) {
  return (
    <section
      className="border bg-fd-card"
      style={{
        borderRadius: 20,
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <div>
        <div
          className="text-fd-muted-foreground"
          style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
        >
          0{n}
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>
          {title}
        </h2>
        <p className="text-fd-muted-foreground" style={{ fontSize: 14, marginTop: 6, maxWidth: 560 }}>
          {desc}
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        {(["light", "dark"] as const).map((tone) => (
          <div
            key={tone}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 28,
              background: surface[tone].bg,
              borderRadius: 12,
              minHeight: 220,
            }}
          >
            {children(tone)}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function LogoLab() {
  return (
    <div
      style={{
        padding: "64px 24px 96px",
        display: "flex",
        flexDirection: "column",
        gap: 32,
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
      }}
    >
      <header>
        <Link
          href="/"
          className="text-fd-muted-foreground"
          style={{ fontSize: 13, textDecoration: "none" }}
        >
          ← back
        </Link>
        <h1
          style={{
            fontSize: 48,
            fontWeight: 650,
            letterSpacing: "-0.05em",
            marginTop: 16,
            lineHeight: 1,
          }}
        >
          logo lab
        </h1>
        <p
          className="text-fd-muted-foreground"
          style={{ fontSize: 16, marginTop: 12, maxWidth: 600 }}
        >
          Each variant on light + dark surfaces. Dithered moving gradient as the logo. Pixels
          are real (Bayer 8×8, low-res, upscaled).
        </p>
      </header>

      <Variant
        n={1}
        title="pill chip — sizing studies"
        desc="Smaller pill, bigger text inside. Four lockup ratios."
      >
        {(tone) => (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              width: "100%",
            }}
          >
            <Sub tone={tone} label="01.01" note="140×34 · 32">
              <Pill w={140} h={34} fontSize={32} weight={650} tracking="-0.04em" />
            </Sub>
            <Sub tone={tone} label="01.02" note="130×32 · 30 tight">
              <Pill w={130} h={32} fontSize={30} weight={700} tracking="-0.05em" />
            </Sub>
            <Sub tone={tone} label="01.03" note="200×52 · 52 hero">
              <Pill w={200} h={52} fontSize={52} weight={650} tracking="-0.05em" />
            </Sub>
            <Sub tone={tone} label="01.04" note="110×28 · 28 dense">
              <Pill w={110} h={28} fontSize={28} weight={700} tracking="-0.05em" />
            </Sub>
          </div>
        )}
      </Variant>

      <Variant
        n={2}
        title="hero block"
        desc="Big diagonal sweep. Sits centered on the homepage as the lead element."
      >
        {() => (
          <div style={{ position: "relative", display: "inline-block", borderRadius: 24, overflow: "hidden" }}>
            <DitherCanvas width={320} height={120} scale={2} mode="linear" speed={0.7} />
            <span style={overlay(64, 700)}>dither</span>
          </div>
        )}
      </Variant>

      <Variant
        n={3}
        title="knockout wordmark"
        desc="Black surround, dithered gradient visible only through the letters (SVG mask). On dark surfaces the surround disappears into the page."
      >
        {(tone) => (
          <div style={{ position: "relative", display: "inline-block", borderRadius: 16, overflow: "hidden" }}>
            <DitherCanvas width={320} height={120} scale={2} mode="sweep" speed={0.9} />
            <svg
              viewBox="0 0 640 240"
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            >
              <defs>
                <mask id={`cut-${tone}`}>
                  <rect width="640" height="240" fill="white" />
                  <text
                    x="320"
                    y="160"
                    textAnchor="middle"
                    fontSize="150"
                    fontWeight={700}
                    fontFamily="Inter, system-ui, sans-serif"
                    letterSpacing="-7"
                    fill="black"
                  >
                    dither
                  </text>
                </mask>
              </defs>
              <rect
                width="640"
                height="240"
                fill={tone === "dark" ? "#0a0a0a" : "#000"}
                mask={`url(#cut-${tone})`}
              />
            </svg>
          </div>
        )}
      </Variant>

      <Variant
        n={4}
        title="mark + logotype"
        desc="Balanced lockup. Text adapts to surface."
      >
        {(tone) => (
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Tile size={56} radius={14} />
            <span style={mark(64, tone)}>dither</span>
          </div>
        )}
      </Variant>

      <Variant
        n={5}
        title="three-tone hero"
        desc="Mid-tone in the dither: bg + grey + accent. Softer than 1-bit."
      >
        {() => (
          <div style={{ position: "relative", display: "inline-block", borderRadius: 24, overflow: "hidden" }}>
            <DitherCanvas
              width={320}
              height={120}
              scale={2}
              mode="linear"
              speed={0.5}
              bg={[15, 15, 20]}
              mid={[120, 120, 140]}
              fg={[245, 245, 255]}
            />
            <span style={overlay(64, 700)}>dither</span>
          </div>
        )}
      </Variant>

      <Variant
        n={6}
        title="WebGL fbm waves + dither"
        desc="Three.js + postprocessing: fbm pattern, Bayer dither pass on top. mix-blend-mode keeps the wordmark legible."
      >
        {() => (
          <div
            style={{
              position: "relative",
              width: "100%",
              height: 320,
              borderRadius: 24,
              overflow: "hidden",
              background: "#000",
            }}
          >
            <Dither
              waveColor={[0.5, 0.5, 0.5]}
              disableAnimation={false}
              enableMouseInteraction={true}
              mouseRadius={0.3}
              colorNum={3}
              waveAmplitude={0.3}
              waveFrequency={3}
              waveSpeed={0.05}
            />
            <span
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontSize: 96,
                fontWeight: 700,
                letterSpacing: "-0.06em",
                pointerEvents: "none",
                mixBlendMode: "difference",
              }}
            >
              dither
            </span>
          </div>
        )}
      </Variant>

      <StopPointsVariant />

      <HoverPointsVariant />

      <MarketingSection />

      <section
        className="text-fd-muted-foreground"
        style={{ fontSize: 13, lineHeight: "22px", maxWidth: 720 }}
      >
        Notes: variants 1–5 use a tiny 2D canvas (Bayer 8×8 ordered dither, low-res, upscaled
        via <code>image-rendering: pixelated</code>; pauses for <code>prefers-reduced-motion</code>).
        Variant 6 is WebGL: fbm pattern → postprocessing dither pass.
      </section>
    </div>
  );
}

function Pill({
  w,
  h,
  fontSize,
  weight = 600,
  tracking = "-0.02em",
}: {
  w: number;
  h: number;
  fontSize: number;
  weight?: number;
  tracking?: string;
}) {
  return (
    <div style={{ position: "relative", display: "inline-block", borderRadius: 999, overflow: "hidden" }}>
      <DitherCanvas width={w} height={h} scale={2} mode="radial" />
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize,
          fontWeight: weight,
          letterSpacing: tracking,
          pointerEvents: "none",
          lineHeight: 1,
        }}
      >
        dither
      </span>
    </div>
  );
}

function Tile({ size, radius }: { size: number; radius: number }) {
  return (
    <div style={{ borderRadius: radius, overflow: "hidden", display: "inline-block", lineHeight: 0 }}>
      <DitherCanvas width={size} height={size} scale={2} mode="radial" speed={1.2} />
    </div>
  );
}

function Sub({
  tone,
  label,
  note,
  children,
}: {
  tone: Tone;
  label: string;
  note: string;
  children: ReactNode;
}) {
  const s = surface[tone];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 20,
        borderRadius: 12,
        background: s.sub,
        minHeight: 160,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", flex: 1 }}>{children}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: s.muted }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: s.muted }}>{note}</span>
      </div>
    </div>
  );
}

const stopPoints = Array.from({ length: 24 }, (_, i) => +(i * 0.3).toFixed(2));

function StopPointsVariant() {
  const [k, setK] = useState(0);
  return (
    <section
      className="border bg-fd-card"
      style={{ borderRadius: 20, padding: 32, display: "flex", flexDirection: "column", gap: 20 }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="text-fd-muted-foreground" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}>
            07
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>
            stop-point picker
          </h2>
          <p className="text-fd-muted-foreground" style={{ fontSize: 14, marginTop: 6, maxWidth: 560 }}>
            Each tile runs a 2.2s easeOutQuint wind-down then freezes at the listed{" "}
            <code>stopAt</code>. Pick the resting pose you like.
          </p>
        </div>
        <button
          onClick={() => setK((n) => n + 1)}
          className="border bg-fd-card hover:bg-fd-accent"
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: "8px 14px",
            borderRadius: 10,
            cursor: "pointer",
          }}
        >
          ↻ replay
        </button>
      </div>

      {(["light", "dark"] as const).map((tone) => (
        <div
          key={tone}
          style={{
            background: surface[tone].bg,
            borderRadius: 12,
            padding: 24,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 16,
          }}
        >
          {stopPoints.map((s) => (
            <div
              key={s}
              style={{
                background: surface[tone].sub,
                borderRadius: 10,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  key={`${k}-${s}`}
                  style={{ borderRadius: 7, overflow: "hidden", display: "inline-block", lineHeight: 0 }}
                >
                  <DitherCanvasStopping
                    width={28}
                    height={28}
                    scale={1}
                    mode="radial"
                    duration={2.2}
                    stopAt={s}
                  />
                </span>
                <span
                  style={{
                    fontSize: 18,
                    fontWeight: 650,
                    letterSpacing: "-0.04em",
                    color: surface[tone].fg,
                    lineHeight: 1,
                  }}
                >
                  dither
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: surface[tone].muted,
                }}
              >
                stopAt={s.toFixed(1)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function HoverTile({ stopAt, tone }: { stopAt: number; tone: Tone }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      style={{
        background: surface[tone].sub,
        borderRadius: 10,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        alignItems: "flex-start",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <DitherCanvasHover
          width={28}
          height={28}
          scale={1}
          mode="radial"
          exitDelay={0.4}
          settleDuration={1.4}
          stopAt={stopAt}
          rounded={7}
          triggerRef={ref}
        />
        <span
          style={{
            fontSize: 18,
            fontWeight: 650,
            letterSpacing: "-0.04em",
            color: surface[tone].fg,
            lineHeight: 1,
          }}
        >
          dither
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          color: surface[tone].muted,
        }}
      >
        stopAt={stopAt.toFixed(1)}
      </div>
    </div>
  );
}

function HoverPointsVariant() {
  return (
    <section
      className="border bg-fd-card"
      style={{ borderRadius: 20, padding: 32, display: "flex", flexDirection: "column", gap: 20 }}
    >
      <div>
        <div className="text-fd-muted-foreground" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}>
          08
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>
          hover-driven stop points
        </h2>
        <p className="text-fd-muted-foreground" style={{ fontSize: 14, marginTop: 6, maxWidth: 600 }}>
          Frozen by default. Hover the mark to wake it up — runs continuously while the
          pointer is over it. Pointer leaves → 0.4s delay → 1.4s eased settle back to{" "}
          <code>stopAt</code>.
        </p>
      </div>

      {(["light", "dark"] as const).map((tone) => (
        <div
          key={tone}
          style={{
            background: surface[tone].bg,
            borderRadius: 12,
            padding: 24,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 16,
          }}
        >
          {stopPoints.map((s) => (
            <HoverTile key={s} stopAt={s} tone={tone} />
          ))}
        </div>
      ))}
    </section>
  );
}

type Row = {
  eyebrow: string;
  title: string;
  body: string;
  shape: "simplex" | "warp" | "dots" | "wave" | "ripple" | "swirl" | "sphere";
  type: "random" | "2x2" | "4x4" | "8x8";
  colorBack: string;
  colorFront: string;
  rounded?: number;
};

const rows: Row[] = [
  {
    eyebrow: "the index",
    title: "A planet of your own data.",
    body: "Every note, page, message, and bookmark — collected, indexed, and searchable from one CLI. Local-first, sandboxed, yours.",
    shape: "sphere",
    type: "8x8",
    colorBack: "#000000",
    colorFront: "#00b3ff",
    rounded: 9999,
  },
  {
    eyebrow: "plugins",
    title: "Pull the world in.",
    body: "Write a Deno plugin in fifty lines. Pull a feed, a folder, an API. Sandboxed by default, granted by you.",
    shape: "wave",
    type: "4x4",
    colorBack: "#0a0a0a",
    colorFront: "#ff5d2e",
    rounded: 28,
  },
  {
    eyebrow: "search",
    title: "qmd hybrid search.",
    body: "Lexical and semantic in one index. Ask in plain language, get answers grounded in your own corpus.",
    shape: "swirl",
    type: "4x4",
    colorBack: "#000000",
    colorFront: "#a3ff3a",
    rounded: 28,
  },
  {
    eyebrow: "agents",
    title: "An MCP server for everything you know.",
    body: "Expose your index to any agent. Coding, research, journaling — all reading from the same ground truth.",
    shape: "ripple",
    type: "8x8",
    colorBack: "#0a0a0a",
    colorFront: "#ffffff",
    rounded: 28,
  },
];

function MarketingSection() {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        marginTop: 24,
      }}
    >
      <header style={{ marginBottom: 8 }}>
        <div
          className="text-fd-muted-foreground"
          style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
        >
          09
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>
          marketing-page pattern
        </h2>
        <p className="text-fd-muted-foreground" style={{ fontSize: 14, marginTop: 6, maxWidth: 560 }}>
          Alternating left/right rows. Dithered shader on one side, copy on the other.
        </p>
      </header>

      {rows.map((row, i) => {
        const flip = i % 2 === 1;
        return (
          <div
            key={row.title}
            className="border bg-fd-card"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 0,
              borderRadius: 24,
              overflow: "hidden",
              minHeight: 360,
            }}
          >
            <div
              style={{
                gridColumn: flip ? 2 : 1,
                gridRow: 1,
                padding: 40,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 12,
              }}
            >
              <div
                className="text-fd-muted-foreground"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                {row.eyebrow}
              </div>
              <h3 style={{ fontSize: 36, fontWeight: 650, letterSpacing: "-0.03em", lineHeight: 1.05 }}>
                {row.title}
              </h3>
              <p
                className="text-fd-muted-foreground"
                style={{ fontSize: 16, lineHeight: "26px", maxWidth: 440 }}
              >
                {row.body}
              </p>
            </div>
            <div
              style={{
                gridColumn: flip ? 1 : 2,
                gridRow: 1,
                padding: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: row.colorBack,
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: 280,
                  borderRadius: row.rounded ?? 16,
                  overflow: "hidden",
                }}
              >
                <Dithering
                  width="100%"
                  height="100%"
                  colorBack={row.colorBack}
                  colorFront={row.colorFront}
                  shape={row.shape}
                  type={row.type}
                  size={2}
                  speed={1}
                  scale={0.6}
                />
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
