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
  fillColor: "#99D892",
};

export function DitheredCta({
  href = "/docs",
  children = "Try it out now",
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="inline-block rounded-[10px] bg-[#99D892] p-2 shadow-[0_2px_4px_rgba(0,0,0,0.18),0_8px_20px_-8px_rgba(0,0,0,0.28),0_22px_48px_-18px_rgba(0,0,0,0.32)]">
      <Link
        href={href}
        className="group bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden px-8 py-4 text-[17px] font-semibold no-underline"
        style={{ borderRadius: 5 }}
      >
        <span className="relative z-[1] inline-flex items-center gap-2">
          <span className="underline decoration-white decoration-2 underline-offset-2">
            {children}
          </span>
          <ArrowRight size={18} />
        </span>
        {/* dither layer — fades out on hover so the clean rectangle peeks through */}
        <span className="pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out will-change-transform group-hover:opacity-0">
          <DiagonalEdgeStrips opts={OPTS} />
        </span>
      </Link>
    </span>
  );
}
