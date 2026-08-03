"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { GitHubLogoIcon } from "@radix-ui/react-icons";
import { DitherCanvasHover } from "@/lib/dither-canvas-hover";

export function HomeNav() {
  const logoRef = useRef<HTMLSpanElement>(null);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  const [scrolled, setScrolled] = useState(false);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="sticky top-0 z-40 p-5">
      <div
        // Always render a 1px border so its space is reserved on both
        // states — only the color toggles, so the unscrolled → scrolled
        // transition doesn't shift content by a pixel.
        className={`relative mx-auto rounded-[28px] border ${
          scrolled
            ? "border-fd-border bg-fd-background/70 max-w-[880px] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.15),0_1px_1px_rgba(255,255,255,0.08)_inset,0_-1px_1px_rgba(255,255,255,0.08)_inset]"
            : "border-fd-border max-w-[1080px] shadow-none"
        }`}
        style={{
          transition:
            "max-width 1200ms cubic-bezier(0.32, 0.72, 0, 1), background-color 800ms, box-shadow 800ms, backdrop-filter 800ms, border-color 800ms",
          backdropFilter: scrolled ? "blur(12px)" : undefined,
          WebkitBackdropFilter: scrolled ? "blur(12px)" : undefined,
        }}
      >
        <nav className="flex items-center gap-5 py-3 pr-4 pl-6">
          <Link
            href="/"
            className="inline-flex items-center text-inherit no-underline"
          >
            <span
              ref={logoRef}
              className="inline-flex items-center gap-[9px]"
            >
              <span
                // Space reserved while the canvas boots so only it fades in —
                // the wordmark is visible immediately.
                className={`inline-flex h-[29px] w-[29px] transition-opacity duration-500 ease-out ${
                  ready ? "opacity-100" : "opacity-0"
                }`}
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
              </span>
              <span className="text-[21px] font-[650] leading-none tracking-[-0.04em] will-change-transform">
                dither
              </span>
            </span>
          </Link>

          {/* desktop links */}
          <div className="ml-auto hidden items-center gap-[18px] md:flex">
            <Link
              href="/docs"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[14px] font-medium no-underline"
            >
              Documentation
            </Link>
            <Link
              href="/#plugins"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[14px] font-medium no-underline"
            >
              Plugins
            </Link>
            <Link
              href="/#manifesto"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[14px] font-medium no-underline"
            >
              Manifesto
            </Link>
            <Link
              href="/#faq"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[14px] font-medium no-underline"
            >
              FAQs
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center rounded-lg border border-[#99D892]/30 bg-[#99D892]/15 px-3.5 py-1.5 text-[14px] font-medium text-[#99D892] no-underline backdrop-blur-md transition-colors hover:bg-[#99D892]/25"
            >
              Install
            </Link>
            <a
              href="https://github.com/janniks/dither"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="group inline-flex items-center pr-0.5 outline-offset-4"
            >
              <GitHubLogoIcon
                aria-hidden
                className="size-[22px] text-fd-muted-foreground transition-colors duration-300 ease-out group-hover:text-fd-foreground/85"
              />
            </a>
          </div>

          {/* mobile hamburger / close */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="text-fd-muted-foreground hover:text-fd-foreground ml-auto inline-flex h-8 w-8 items-center justify-center rounded-full md:hidden"
          >
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
            {open ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
                aria-hidden
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
                aria-hidden
              >
                <line x1="4" x2="20" y1="6" y2="6" />
                <line x1="4" x2="20" y1="12" y2="12" />
                <line x1="4" x2="20" y1="18" y2="18" />
              </svg>
            )}
          </button>
        </nav>
      </div>

      {/* mobile expandable panel — rendered as a sibling of the pill so no
          ancestor backdrop-filter breaks the blur. Sized to its content. */}
      <div
        className={`pointer-events-none absolute inset-x-7 top-[82px] z-30 grid overflow-hidden rounded-[20px] border border-fd-border bg-fd-background/50 shadow-[0_12px_24px_-12px_rgba(0,0,0,0.25),0_1px_1px_rgba(255,255,255,0.06)_inset] transition-[grid-template-rows,opacity] duration-300 ease-out md:hidden ${
          open
            ? "!pointer-events-auto grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        }`}
        style={{
          backdropFilter: "blur(20px) saturate(140%)",
          WebkitBackdropFilter: "blur(20px) saturate(140%)",
        }}
      >
        <div className="min-h-0">
          <div className="flex flex-col gap-1 p-2">
            <Link
              href="/docs"
              onClick={() => setOpen(false)}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-medium no-underline"
            >
              Documentation
            </Link>
            <Link
              href="/#plugins"
              onClick={() => setOpen(false)}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-medium no-underline"
            >
              Plugins
            </Link>
            <Link
              href="/#manifesto"
              onClick={() => setOpen(false)}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-medium no-underline"
            >
              Manifesto
            </Link>
            <Link
              href="/#faq"
              onClick={() => setOpen(false)}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-medium no-underline"
            >
              FAQs
            </Link>
            <Link
              href="/docs"
              onClick={() => setOpen(false)}
              className="border-[#99D892]/30 bg-[#99D892]/15 text-[#99D892] hover:bg-[#99D892]/25 inline-flex items-center rounded-lg border px-3 py-2 text-[14px] font-medium no-underline"
            >
              Install
            </Link>
            <a
              href="https://github.com/janniks/dither"
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-[14px] font-medium no-underline"
            >
              <GitHubLogoIcon
                aria-hidden
                className="size-[18px]"
              />
              GitHub
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
