"use client";
import { useEffect, useRef, type CSSProperties } from "react";

const bayer = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function jitterFor(seed: string, cx: number, cy: number): number {
  let h = seed.charCodeAt(0) * 73856093 + cx * 19349663 + cy * 83492791;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h ^= h >>> 16;
  return (((h >>> 0) % 1024) / 1023 - 0.5);
}

export type DitherStripOpts = {
  thickness: number;
  cellPx: number;
  falloff: number;
  acrossFalloff: number;
  jitter: number;
  densityScale: number;
};

export type DitherStripEdge = "top" | "bottom" | "left" | "right";

export function EdgeStrip({
  edge,
  origin,
  opts,
}: {
  edge: DitherStripEdge;
  origin: 0 | 1;
  opts: DitherStripOpts;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const parent = c.parentElement;
    if (!parent) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const rect = parent.getBoundingClientRect();
      const isHorizontal = edge === "top" || edge === "bottom";
      const lengthPx = isHorizontal ? rect.width : rect.height;
      if (lengthPx < 2) return;
      const cellsAlong = Math.max(2, Math.round(lengthPx / opts.cellPx));
      const cellsAcross = Math.max(
        2,
        Math.round(opts.thickness / opts.cellPx),
      );

      const w = isHorizontal ? cellsAlong : cellsAcross;
      const h = isHorizontal ? cellsAcross : cellsAlong;
      c.width = w;
      c.height = h;
      c.style.width = (isHorizontal ? lengthPx : opts.thickness) + "px";
      c.style.height = (isHorizontal ? opts.thickness : lengthPx) + "px";

      const styles = getComputedStyle(document.documentElement);
      ctx.fillStyle =
        styles.getPropertyValue("--color-fd-background").trim() || "#0a0a0a";
      ctx.clearRect(0, 0, w, h);

      const safeFalloff = Math.max(0.1, opts.falloff);
      const safeAcross = Math.max(0.1, opts.acrossFalloff);

      for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++) {
          let along: number, across: number;
          if (isHorizontal) {
            along = cx / (w - 1);
            across = cy / (h - 1);
            if (edge === "bottom") across = 1 - across;
          } else {
            along = cy / (h - 1);
            across = cx / (w - 1);
            if (edge === "right") across = 1 - across;
          }
          if (origin === 1) along = 1 - along;

          const alongFactor = Math.pow(
            Math.max(0, 1 - along),
            1 / safeFalloff,
          );
          const acrossFactor = Math.pow(
            Math.max(0, 1 - across),
            1 / safeAcross,
          );
          const coverage = alongFactor * acrossFactor * opts.densityScale;
          const t =
            (bayer[cy & 7][cx & 7] + 0.5) / 64 +
            opts.jitter * jitterFor(edge + origin, cx, cy);
          if (coverage > t) ctx.fillRect(cx, cy, 1, 1);
        }
      }
    };

    render();
    const obs = new ResizeObserver(render);
    obs.observe(parent);
    return () => obs.disconnect();
  }, [edge, origin, opts]);

  const positionStyle: CSSProperties = (() => {
    switch (edge) {
      case "top":
        return { top: 0, left: 0, right: 0 };
      case "bottom":
        return { bottom: 0, left: 0, right: 0 };
      case "left":
        return { top: 0, bottom: 0, left: 0 };
      case "right":
        return { top: 0, bottom: 0, right: 0 };
    }
  })();

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{ ...positionStyle, imageRendering: "pixelated" }}
    />
  );
}

/** TL+BR diagonal · all edges. Most common preset. */
export function DiagonalEdgeStrips({ opts }: { opts: DitherStripOpts }) {
  return (
    <>
      <EdgeStrip edge="top" origin={0} opts={opts} />
      <EdgeStrip edge="left" origin={0} opts={opts} />
      <EdgeStrip edge="bottom" origin={1} opts={opts} />
      <EdgeStrip edge="right" origin={1} opts={opts} />
    </>
  );
}
