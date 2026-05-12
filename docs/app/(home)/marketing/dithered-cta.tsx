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
};

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
      className="bg-fd-primary text-fd-primary-foreground relative inline-flex items-center gap-2 overflow-hidden px-8 py-4 text-[17px] font-semibold no-underline"
      style={{ borderRadius: 11 }}
    >
      <span className="relative z-[1] inline-flex items-center gap-2">
        <span className="underline decoration-white decoration-2 underline-offset-2">
          {children}
        </span>
        <ArrowRight size={18} />
      </span>
      <DiagonalEdgeStrips opts={OPTS} />
    </Link>
  );
}
