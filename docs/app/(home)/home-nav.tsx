"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { DitherCanvasHover } from "@/lib/dither-canvas-hover";

const ghMarkMask = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15"><path fill="white" fill-rule="evenodd" clip-rule="evenodd" d="M7.49933 0.25C3.49635 0.25 0.25 3.49593 0.25 7.50024C0.25 10.703 2.32715 13.4206 5.2081 14.3797C5.57084 14.446 5.70302 14.2222 5.70302 14.0299C5.70302 13.8576 5.69679 13.4019 5.69323 12.797C3.67661 13.235 3.25112 11.825 3.25112 11.825C2.92132 10.9874 2.44599 10.7644 2.44599 10.7644C1.78773 10.3149 2.49584 10.3238 2.49584 10.3238C3.22353 10.375 3.60629 11.0711 3.60629 11.0711C4.25298 12.1788 5.30335 11.8588 5.71638 11.6732C5.78225 11.205 5.96962 10.8854 6.17658 10.7043C4.56675 10.5209 2.87415 9.89918 2.87415 7.12104C2.87415 6.32925 3.15677 5.68257 3.62053 5.17563C3.54576 4.99226 3.29697 4.25521 3.69174 3.25691C3.69174 3.25691 4.30015 3.06196 5.68522 3.99973C6.26337 3.83906 6.8838 3.75895 7.50022 3.75583C8.1162 3.75895 8.73619 3.83906 9.31523 3.99973C10.6994 3.06196 11.3069 3.25691 11.3069 3.25691C11.7026 4.25521 11.4538 4.99226 11.3795 5.17563C11.8441 5.68257 12.1245 6.32925 12.1245 7.12104C12.1245 9.9063 10.4292 10.5192 8.81452 10.6985C9.07444 10.9224 9.30633 11.3648 9.30633 12.0413C9.30633 13.0102 9.29742 13.7922 9.29742 14.0299C9.29742 14.2239 9.42828 14.4496 9.79591 14.3788C12.6746 13.4179 14.75 10.7025 14.75 7.50024C14.75 3.49593 11.5036 0.25 7.49933 0.25Z"/></svg>',
)}")`;

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
            : "border-transparent max-w-[1080px] shadow-none"
        }`}
        style={{
          transition:
            "max-width 1200ms cubic-bezier(0.32, 0.72, 0, 1), background-color 800ms, box-shadow 800ms, backdrop-filter 800ms, border-color 800ms",
          backdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
          WebkitBackdropFilter: scrolled ? "blur(12px)" : "blur(0px)",
        }}
      >
        <nav className="flex items-center gap-5 py-3 pr-4 pl-6">
          <Link
            href="/"
            className="inline-flex items-center text-inherit no-underline"
          >
            <span
              ref={logoRef}
              className={`inline-flex items-center gap-[9px] transition-opacity duration-500 ease-out ${
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
              <span className="text-[21px] font-[650] leading-none tracking-[-0.04em] will-change-transform">
                dither
              </span>
            </span>
          </Link>

          {/* desktop links */}
          <div className="ml-auto hidden items-center gap-[18px] md:flex">
            <Link
              href="/docs"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-semibold no-underline"
            >
              Documentation
            </Link>
            <Link
              href="/#marketplace"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-semibold no-underline"
            >
              Plugins
            </Link>
            <Link
              href="/#manifesto"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-semibold no-underline"
            >
              Manifesto
            </Link>
            <Link
              href="/#faq"
              className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-semibold no-underline"
            >
              FAQs
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center rounded-lg border border-[#99D892]/30 bg-[#99D892]/15 px-3.5 py-1.5 text-[13px] font-semibold text-[#99D892] no-underline backdrop-blur-md transition-colors hover:bg-[#99D892]/25"
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
              <span
                aria-hidden
                className="block size-[22px] bg-linear-to-br from-fd-muted-foreground to-fd-foreground/50 mask-contain mask-center mask-no-repeat transition-[filter] duration-300 ease-out group-hover:brightness-110 group-hover:to-fd-foreground/85 dark:group-hover:brightness-125"
                style={{ maskImage: ghMarkMask, WebkitMaskImage: ghMarkMask }}
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

        {/* mobile expandable panel — absolute so it doesn't grow the sticky pill
            (which would push the rest of the page down on open) */}
        <div
          className={`absolute inset-x-2 top-full mt-2 grid overflow-hidden rounded-[20px] border bg-fd-background/60 backdrop-blur-xl shadow-[0_12px_24px_-12px_rgba(0,0,0,0.25),0_1px_1px_rgba(255,255,255,0.06)_inset] transition-[grid-template-rows,opacity] duration-300 ease-out md:hidden ${
            open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0">
            <div className="flex flex-col gap-1 p-2">
              <Link
                href="/docs"
                onClick={() => setOpen(false)}
                className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline"
              >
                Documentation
              </Link>
              <Link
                href="/#marketplace"
                onClick={() => setOpen(false)}
                className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline"
              >
                Plugins
              </Link>
              <Link
                href="/#manifesto"
                onClick={() => setOpen(false)}
                className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline"
              >
                Manifesto
              </Link>
              <Link
                href="/#faq"
                onClick={() => setOpen(false)}
                className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline"
              >
                FAQs
              </Link>
              <Link
                href="/docs"
                onClick={() => setOpen(false)}
                className="border-[#99D892]/30 bg-[#99D892]/15 text-[#99D892] hover:bg-[#99D892]/25 inline-flex items-center rounded-lg border px-3 py-2 text-[14px] font-semibold no-underline backdrop-blur-md"
              >
                Install
              </Link>
              <a
                href="https://github.com/janniks/dither"
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/40 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline"
              >
                <span
                  aria-hidden
                  className="block size-[18px] bg-linear-to-br from-fd-muted-foreground to-fd-foreground/60 mask-contain mask-center mask-no-repeat"
                  style={{ maskImage: ghMarkMask, WebkitMaskImage: ghMarkMask }}
                />
                GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
