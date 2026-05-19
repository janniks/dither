"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Search } from "lucide-react";
import { DitherCanvasHover } from "@/lib/dither-canvas-hover";

type Tone = "light" | "dark";

const surface: Record<Tone, { page: string; card: string; muted: string; fg: string }> = {
  light: { page: "#f5f5f5", card: "#ffffff", muted: "#737373", fg: "#0a0a0a" },
  dark: { page: "#0a0a0a", card: "#171717", muted: "#737373", fg: "#f5f5f5" },
};

const links = [
  { name: "Docs", href: "/docs" },
  { name: "Lab", href: "/logo-lab" },
  { name: "Manifesto", href: "#" },
];

function Stage({ children, tone }: { children: ReactNode; tone: Tone }) {
  return (
    <div
      style={{
        position: "relative",
        background: surface[tone].page,
        borderRadius: 16,
        height: 280,
        overflow: "hidden",
        border: tone === "dark" ? "1px solid #222" : "1px solid #e5e5e5",
      }}
    >
      {children}
      <div
        style={{
          position: "absolute",
          inset: 0,
          top: 100,
          padding: 32,
          color: surface[tone].muted,
          fontSize: 13,
          lineHeight: "22px",
        }}
      >
        — page content placeholder —
      </div>
    </div>
  );
}

function VariantCard({
  n,
  title,
  desc,
  children,
}: {
  n: string;
  title: string;
  desc: string;
  children: (tone: Tone) => ReactNode;
}) {
  return (
    <section
      className="border bg-fd-card"
      style={{ borderRadius: 20, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div>
        <div className="text-fd-muted-foreground" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}>
          {n}
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>
          {title}
        </h2>
        <p className="text-fd-muted-foreground" style={{ fontSize: 13, marginTop: 4, maxWidth: 600 }}>
          {desc}
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 12 }}>
        {(["light", "dark"] as const).map((tone) => (
          <Stage key={tone} tone={tone}>
            {children(tone)}
          </Stage>
        ))}
      </div>
    </section>
  );
}

const wordmark = (tone: Tone, size = 18): CSSProperties => ({
  fontSize: size,
  fontWeight: 650,
  letterSpacing: "-0.04em",
  color: surface[tone].fg,
  lineHeight: 1,
});

const linkStyle = (tone: Tone): CSSProperties => ({
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  color: surface[tone].muted,
});

const ctaStyle = (tone: Tone): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 12,
  textDecoration: "none",
  color: tone === "light" ? "#fff" : "#0a0a0a",
  background: tone === "light" ? "#171717" : "#f5f5f5",
  border: tone === "light" ? "1px solid #171717" : "1px solid #f5f5f5",
  boxShadow:
    tone === "light"
      ? "0 1px 2px rgba(0,0,0,0.3), 0 1px 3px rgba(255,255,255,0.1) inset"
      : "0 1px 2px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.2) inset",
});

function NavLogoMini({ tone }: { tone: Tone }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isDark = tone === "dark";
  return (
    <span ref={ref} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <DitherCanvasHover
        width={24}
        height={24}
        scale={1}
        mode="radial"
        exitDelay={0.3}
        settleDuration={1.4}
        stopAt={2.6}
        rounded={6}
        bg={isDark ? [245, 245, 245] : [10, 10, 10]}
        fg={isDark ? [10, 10, 10] : [255, 255, 255]}
        triggerRef={ref}
      />
      <span style={wordmark(tone)}>dither</span>
    </span>
  );
}

// 01 — mmry-style floating pill, expanded (top of page)
function PillExpanded({ tone }: { tone: Tone }) {
  const bg = tone === "light" ? "rgba(255,255,255,0.7)" : "rgba(23,23,23,0.7)";
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 20, zIndex: 10 }}>
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          background: bg,
          borderRadius: 24,
          border: tone === "dark" ? "1px solid rgba(255,255,255,0.06)" : "1px solid rgba(255,255,255,0)",
          boxShadow: "0 1px 2px rgba(255,255,255,0.2) inset",
        }}
      >
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 20px",
          }}
        >
          <NavLogoMini tone={tone} />
          <div style={{ display: "flex", gap: 24 }}>
            {links.map((l) => (
              <a key={l.name} href={l.href} style={linkStyle(tone)}>
                {l.name}
              </a>
            ))}
          </div>
          <a href="/docs" style={ctaStyle(tone)}>
            Get started
          </a>
        </nav>
      </div>
    </div>
  );
}

// 02 — mmry-style floating pill, scrolled (narrower, backdrop blur, shadow)
function PillScrolled({ tone }: { tone: Tone }) {
  const bg = tone === "light" ? "rgba(255,255,255,0.7)" : "rgba(23,23,23,0.7)";
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 20, zIndex: 10 }}>
      <div
        style={{
          maxWidth: 560,
          margin: "0 auto",
          background: bg,
          borderRadius: 24,
          border: tone === "dark" ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          boxShadow:
            "0 10px 30px -10px rgba(0,0,0,0.25), 0 1px 2px rgba(255,255,255,0.2) inset",
        }}
      >
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 16px",
          }}
        >
          <NavLogoMini tone={tone} />
          <div style={{ display: "flex", gap: 20 }}>
            {links.map((l) => (
              <a key={l.name} href={l.href} style={{ ...linkStyle(tone), fontSize: 13 }}>
                {l.name}
              </a>
            ))}
          </div>
          <a href="/docs" style={{ ...ctaStyle(tone), padding: "6px 12px", fontSize: 12 }}>
            Get started
          </a>
        </nav>
      </div>
    </div>
  );
}

// 03 — animated, transitions on real scroll inside the stage
function PillScrollAnimated({ tone }: { tone: Tone }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onScroll = () => setScrolled(stage.scrollTop > 30);
    stage.addEventListener("scroll", onScroll);
    return () => stage.removeEventListener("scroll", onScroll);
  }, []);
  const bg = tone === "light" ? "rgba(255,255,255,0.7)" : "rgba(23,23,23,0.7)";
  return (
    <div
      ref={stageRef}
      style={{ position: "absolute", inset: 0, overflowY: "auto" }}
    >
      <div style={{ position: "sticky", top: 0, padding: 20, zIndex: 10 }}>
        <div
          style={{
            maxWidth: scrolled ? 560 : 720,
            margin: "0 auto",
            transition: "max-width 700ms cubic-bezier(0.32, 0.72, 0, 1), background 700ms, box-shadow 700ms, backdrop-filter 700ms",
            background: bg,
            borderRadius: 24,
            border: scrolled
              ? tone === "dark"
                ? "1px solid rgba(255,255,255,0.08)"
                : "1px solid rgba(0,0,0,0.06)"
              : "1px solid transparent",
            backdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
            WebkitBackdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
            boxShadow: scrolled
              ? "0 10px 30px -10px rgba(0,0,0,0.25), 0 1px 2px rgba(255,255,255,0.2) inset"
              : "0 1px 2px rgba(255,255,255,0.2) inset",
          }}
        >
          <nav
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: scrolled ? "8px 16px" : "10px 20px",
              transition: "padding 700ms",
            }}
          >
            <NavLogoMini tone={tone} />
            <div style={{ display: "flex", gap: 20 }}>
              {links.map((l) => (
                <a key={l.name} href={l.href} style={linkStyle(tone)}>
                  {l.name}
                </a>
              ))}
            </div>
            <a href="/docs" style={ctaStyle(tone)}>
              Get started
            </a>
          </nav>
        </div>
      </div>
      <div style={{ height: 800, padding: "32px 32px 0", color: surface[tone].muted, fontSize: 13 }}>
        ↓ scroll inside this card to see the transition ↓
      </div>
    </div>
  );
}

// 04 — pill with inline search slot
function PillWithSearch({ tone }: { tone: Tone }) {
  const bg = tone === "light" ? "rgba(255,255,255,0.7)" : "rgba(23,23,23,0.7)";
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 20, zIndex: 10 }}>
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          background: bg,
          borderRadius: 24,
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: tone === "dark" ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
          boxShadow: "0 1px 2px rgba(255,255,255,0.2) inset",
        }}
      >
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "8px 10px 8px 20px",
          }}
        >
          <NavLogoMini tone={tone} />
          <div style={{ display: "flex", gap: 18, marginLeft: 16 }}>
            {links.map((l) => (
              <a key={l.name} href={l.href} style={linkStyle(tone)}>
                {l.name}
              </a>
            ))}
          </div>
          <button
            type="button"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px 6px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              color: surface[tone].muted,
              background: tone === "light" ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)",
              border: "1px solid transparent",
              cursor: "pointer",
            }}
          >
            <Search size={13} />
            Search
            <span
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 6,
                background: tone === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)",
              }}
            >
              ⌘K
            </span>
          </button>
          <a href="/docs" style={{ ...ctaStyle(tone), padding: "6px 12px", fontSize: 12 }}>
            Get started
          </a>
        </nav>
      </div>
    </div>
  );
}

// 05 — segmented: logo capsule | links capsule | cta capsule (three floating chips)
function PillSegmented({ tone }: { tone: Tone }) {
  const bg = tone === "light" ? "rgba(255,255,255,0.8)" : "rgba(23,23,23,0.8)";
  const segStyle: CSSProperties = {
    background: bg,
    borderRadius: 999,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: tone === "dark" ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
    boxShadow: "0 1px 2px rgba(255,255,255,0.2) inset",
    padding: "8px 14px",
    display: "inline-flex",
    alignItems: "center",
    gap: 14,
  };
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        padding: 20,
        zIndex: 10,
        display: "flex",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <div style={segStyle}>
        <NavLogoMini tone={tone} />
      </div>
      <div style={segStyle}>
        {links.map((l) => (
          <a key={l.name} href={l.href} style={{ ...linkStyle(tone), fontSize: 13 }}>
            {l.name}
          </a>
        ))}
      </div>
      <div style={segStyle}>
        <a href="/docs" style={{ ...ctaStyle(tone), padding: "4px 12px", fontSize: 12 }}>
          Get started
        </a>
      </div>
    </div>
  );
}

// 06 — full-width glass bar (current style, for reference)
function FullWidthGlass({ tone }: { tone: Tone }) {
  const bg = tone === "light" ? "rgba(255,255,255,0.8)" : "rgba(10,10,10,0.8)";
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        background: bg,
        borderBottom:
          tone === "dark" ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <nav
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "10px 20px",
        }}
      >
        <NavLogoMini tone={tone} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 20, alignItems: "center" }}>
          {links.map((l) => (
            <a key={l.name} href={l.href} style={linkStyle(tone)}>
              {l.name}
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default function NavLab() {
  return (
    <div
      style={{
        padding: "64px 24px 96px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
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
          nav lab
        </h1>
        <p className="text-fd-muted-foreground" style={{ fontSize: 16, marginTop: 12, maxWidth: 600 }}>
          Floating pill nav inspired by mmry. Each card shows a navbar pinned to the top of a fake
          page, on light + dark surfaces. Current site nav is unchanged.
        </p>
      </header>

      <VariantCard
        n="01"
        title="floating pill — expanded"
        desc="Wide pill, soft inset highlight, no shadow. The 'at top of page' state."
      >
        {(tone) => <PillExpanded tone={tone} />}
      </VariantCard>

      <VariantCard
        n="02"
        title="floating pill — scrolled"
        desc="Narrower, with backdrop blur, border, and drop shadow. The 'after scroll' state."
      >
        {(tone) => <PillScrolled tone={tone} />}
      </VariantCard>

      <VariantCard
        n="03"
        title="floating pill — animated on scroll"
        desc="Live transition: scroll inside the card to see the pill morph from expanded → scrolled."
      >
        {(tone) => <PillScrollAnimated tone={tone} />}
      </VariantCard>

      <VariantCard
        n="04"
        title="floating pill + inline search"
        desc="Same pill, with a ⌘K search affordance next to the CTA."
      >
        {(tone) => <PillWithSearch tone={tone} />}
      </VariantCard>

      <VariantCard
        n="05"
        title="segmented capsules"
        desc="Three independent floating chips: logo, links, CTA. Reads as a toolbar, not a bar."
      >
        {(tone) => <PillSegmented tone={tone} />}
      </VariantCard>

      <VariantCard
        n="06"
        title="full-width glass (current)"
        desc="The shipping nav, for direct comparison."
      >
        {(tone) => <FullWidthGlass tone={tone} />}
      </VariantCard>
    </div>
  );
}
