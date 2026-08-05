"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  DiagonalEdgeStrips,
  type DitherStripOpts,
} from "@/lib/dither-edge-strip";

const OPTS: DitherStripOpts = {
  thickness: 24,
  cellPx: 3,
  falloff: 0.4,
  acrossFalloff: 0.6,
  // jitter drives how many cells flicker per frame (only cells within
  // `jitter` of the Bayer threshold re-roll) — raised from 0.05 so the
  // live shimmer reads
  jitter: 0.2,
  densityScale: 1.25,
  // dither pixels match the surrounding wrapper, not the page bg
  fillColor: "rgba(153,216,146,0.3)",
  animateMs: 260,
};

// "Double line" frame: single 3px border (manifesto thickness), square
// corners, an inset background-colored line for the classic double frame,
// plus a solid offset hard shadow. Dither corners shimmer live and fade on
// hover.
export function DitheredCta({
  href = "/docs",
  children = "Try it out now",
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group relative inline-flex items-center gap-2 overflow-hidden rounded-none border-[3px] border-[#99D892]/45 bg-[#99D892]/15 px-8 py-4 text-[17px] font-semibold text-[#A0DC99] no-underline shadow-[inset_0_0_0_3px_var(--color-fd-background),5px_5px_0_rgba(153,216,146,0.22)] backdrop-blur-md transition-colors hover:bg-[#99D892]/25"
    >
      <span
        className="relative z-[1] inline-flex items-center gap-2"
        style={{
          textShadow:
            "0 1px 2px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.25)",
        }}
      >
        {children}
        <ArrowRight size={18} />
      </span>
      <span className="pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out will-change-transform group-hover:opacity-50">
        <DiagonalEdgeStrips opts={OPTS} />
      </span>
    </Link>
  );
}
