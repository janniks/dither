"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { LargeSearchToggle } from "fumadocs-ui/components/layout/search-toggle";
import { DitherCanvasHover } from "@/lib/dither-canvas-hover";

export function HomeNav() {
  const logoRef = useRef<HTMLSpanElement>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  const [scrolled, setScrolled] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        padding: 20,
      }}
    >
      <div
        className={scrolled ? "border bg-fd-background/70" : ""}
        style={{
          maxWidth: scrolled ? 880 : 1080,
          margin: "0 auto",
          borderRadius: 28,
          transition:
            "max-width 1200ms cubic-bezier(0.32, 0.72, 0, 1), background-color 800ms, box-shadow 800ms, backdrop-filter 800ms, border-color 800ms",
          backdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
          WebkitBackdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
          boxShadow: scrolled
            ? "0 8px 24px -12px rgba(0,0,0,0.15), 0 1px 1px rgba(255,255,255,0.08) inset, 0 -1px 1px rgba(255,255,255,0.08) inset"
            : "none",
        }}
      >
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            padding: "12px 16px 12px 24px",
          }}
        >
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <span
              ref={logoRef}
              className={`transition-opacity duration-500 ease-out ${ready ? "opacity-100" : "opacity-0"}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 9 }}
            >
              <DitherCanvasHover
                key={isDark ? "dark" : "light"}
                width={29}
                height={29}
                scale={1}
                mode="radial"
                exitDelay={0.3}
                settleDuration={1.4}
                stopAt={2.6}
                rounded={7}
                bg={isDark ? [245, 245, 245] : [10, 10, 10]}
                fg={isDark ? [10, 10, 10] : [255, 255, 255]}
                triggerRef={logoRef}
                onReady={() => setReady(true)}
              />
              <span
                style={{
                  fontSize: 21,
                  fontWeight: 650,
                  letterSpacing: "-0.04em",
                  lineHeight: 1,
                }}
              >
                dither
              </span>
            </span>
          </Link>

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 18,
            }}
          >
            <Link
              href="/docs"
              className="text-fd-muted-foreground hover:text-fd-foreground"
              style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}
            >
              Docs
            </Link>
            <Link
              href="/logo-lab"
              className="text-fd-muted-foreground hover:text-fd-foreground"
              style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}
            >
              Logo Lab
            </Link>
            <Link
              href="/nav-lab"
              className="text-fd-muted-foreground hover:text-fd-foreground"
              style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}
            >
              Nav Lab
            </Link>
            <a
              href="https://github.com/janniks/openindex"
              target="_blank"
              rel="noreferrer"
              className="text-fd-muted-foreground hover:text-fd-foreground"
              style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}
            >
              GitHub
            </a>
            <div style={{ width: 200 }}>
              <LargeSearchToggle style={{ width: "100%" }} />
            </div>
          </div>
        </nav>
      </div>
    </div>
  );
}
