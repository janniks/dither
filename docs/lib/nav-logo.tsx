"use client";
import { useRef } from "react";
import { DitherCanvasHover } from "./dither-canvas-hover";

export function NavLogo() {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span ref={ref} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <DitherCanvasHover
        width={28}
        height={28}
        scale={1}
        mode="radial"
        exitDelay={0.3}
        settleDuration={1.4}
        stopAt={2.6}
        rounded={7}
        triggerRef={ref}
      />
      <span
        style={{
          fontSize: 20,
          fontWeight: 650,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        dither
      </span>
    </span>
  );
}
