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
  jitter: 0.05,
  densityScale: 1.25,
  // dither pixels match the surrounding wrapper, not the page bg
  fillColor: "rgba(153,216,146,0.3)",
};

// Nav-install style: translucent green tint, green text + border, blurred bg.
// Same dither corners + fade-on-hover, just dressed differently.
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
      className="group relative inline-flex items-center gap-2 overflow-hidden rounded-[11px] border-4 border-[#99D892]/30 bg-[#99D892]/15 px-8 py-4 text-[17px] font-semibold text-[#A0DC99] no-underline shadow-[0_0_0_1px_rgba(153,216,146,0.62),inset_0_1px_3px_rgba(0,0,0,0.146)] backdrop-blur-md transition-colors hover:bg-[#99D892]/25"
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
