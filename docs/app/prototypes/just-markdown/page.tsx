"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import VariantReplay from "./variant-replay";
import VariantVault from "./variant-vault";
import VariantConveyor from "./variant-conveyor";

const VARIANTS = [
  { label: "Replay", Component: VariantReplay },
  { label: "Vault", Component: VariantVault },
  { label: "Conveyor", Component: VariantConveyor },
];

const PICKER_CSS = `
.proto-picker {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
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

.proto-picker-highlight {
  position: absolute;
  top: 4px;
  left: 0;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  will-change: transform;
}

/* The slide is enabled only after first paint (data-ready), so load doesn't animate. */
.proto-picker[data-ready] .proto-picker-highlight {
  transition:
    transform 250ms cubic-bezier(0.23, 1, 0.32, 1),
    width 250ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-reduced-motion: reduce) {
  .proto-picker[data-ready] .proto-picker-highlight { transition: none; }
}

.proto-picker-item {
  position: relative; /* sits above the highlight */
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

.proto-picker-item:hover {
  color: rgba(255, 255, 255, 0.85);
}

.proto-picker-item:active {
  transform: scale(0.97);
}

.proto-picker-item:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}

.proto-picker-item[data-active] {
  color: #fff;
}

.proto-picker-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.12);
}

.proto-picker-replay {
  padding: 0 10px;
  font-size: 14px;
}

.proto-picker[data-position="top"] {
  bottom: auto;
  top: 24px;
}
`;

function Skeleton() {
  return (
    <section aria-hidden="true" className="flex flex-col gap-4 opacity-40">
      <div className="h-8 w-1/3 rounded-lg bg-fd-muted/40" />
      <div className="h-4 w-2/3 rounded-lg bg-fd-muted/40" />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-32 rounded-xl bg-fd-muted/40" />
        <div className="h-32 rounded-xl bg-fd-muted/40" />
        <div className="h-32 rounded-xl bg-fd-muted/40" />
      </div>
    </section>
  );
}

export default function JustMarkdownPrototypePage() {
  const [index, setIndex] = useState(0);
  const [replayCount, setReplayCount] = useState(0);
  const [ready, setReady] = useState(false);

  const pickerRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const highlightRef = useRef<HTMLSpanElement | null>(null);

  const moveHighlight = useCallback(() => {
    const el = itemRefs.current[index];
    const highlight = highlightRef.current;
    if (!el || !highlight) return;
    highlight.style.width = `${el.offsetWidth}px`;
    highlight.style.transform = `translateX(${el.offsetLeft}px)`;
  }, [index]);

  // Restore selection from ?v= before first paint.
  useLayoutEffect(() => {
    const v = parseInt(
      new URLSearchParams(window.location.search).get("v") ?? "",
      10,
    );
    if (v >= 1 && v <= VARIANTS.length) setIndex(v - 1);
  }, []);

  useLayoutEffect(() => {
    moveHighlight();
  }, [moveHighlight]);

  useEffect(() => {
    window.addEventListener("resize", moveHighlight);
    return () => window.removeEventListener("resize", moveHighlight);
  }, [moveHighlight]);

  // Enable the slide only after first paint, so load doesn't animate.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(index + 1));
    window.history.replaceState(null, "", url);
  }, [index]);

  const replay = useCallback(() => setReplayCount((n) => n + 1), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= VARIANTS.length) setIndex(num - 1);
      else if (e.key === "ArrowRight")
        setIndex((i) => (i + 1) % VARIANTS.length);
      else if (e.key === "ArrowLeft")
        setIndex((i) => (i - 1 + VARIANTS.length) % VARIANTS.length);
      else if (e.key === "r" || e.key === "R") replay();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [replay]);

  const Active = VARIANTS[index].Component;

  return (
    <div className="min-h-screen bg-fd-background text-fd-foreground">
      <style>{PICKER_CSS}</style>

      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-24 px-6 py-16 pb-40">
        <Skeleton />

        <div key={`${index}-${replayCount}`}>
          <Active />
        </div>

        <Skeleton />
      </div>

      <nav
        className="proto-picker"
        aria-label="Prototype variants"
        ref={pickerRef}
        {...(ready ? { "data-ready": "" } : {})}
      >
        <span
          className="proto-picker-highlight"
          aria-hidden="true"
          ref={highlightRef}
        />
        {VARIANTS.map((variant, i) => (
          <button
            key={variant.label}
            className="proto-picker-item"
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            onClick={() => setIndex(i)}
            {...(i === index
              ? { "data-active": "", "aria-current": "true" as const }
              : {})}
          >
            {variant.label}
          </button>
        ))}
        <span className="proto-picker-divider" aria-hidden="true" />
        <button
          className="proto-picker-item proto-picker-replay"
          aria-label="Replay animation (R)"
          onClick={replay}
        >
          ↻
        </button>
      </nav>
    </div>
  );
}
