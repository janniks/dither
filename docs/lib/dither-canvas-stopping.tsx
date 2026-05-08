"use client";
import { useEffect, useRef } from "react";

type RGB = [number, number, number];
type Mode = "radial" | "linear" | "sweep";

type Props = {
  width: number;
  height: number;
  scale?: number;
  bg?: RGB;
  fg?: RGB;
  mid?: RGB;
  mode?: Mode;
  duration?: number;
  stopAt?: number;
  rounded?: number;
};

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

export function DitherCanvasStopping({
  width,
  height,
  scale = 2,
  bg = [10, 10, 10],
  fg = [255, 255, 255],
  mid,
  mode = "radial",
  duration = 2.4,
  stopAt = 2.6,
  rounded = 0,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = ctx.createImageData(width, height);
    const start = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;

    const render = (t: number) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let v: number;
          if (mode === "radial") {
            const cx = width / 2 + Math.cos(t * 0.6) * width * 0.3;
            const cy = height / 2 + Math.sin(t * 0.85) * height * 0.5;
            const dx = (x - cx) / width;
            const dy = (y - cy) / height;
            v = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.5);
          } else if (mode === "linear") {
            const a = t * 0.35;
            const nx = Math.cos(a);
            const ny = Math.sin(a);
            v = ((x / width) * nx + (y / height) * ny + 1) / 2;
            v = (v + t * 0.12) % 1;
          } else {
            const cx = width / 2;
            const cy = height / 2;
            v = (Math.atan2(y - cy, x - cx) / Math.PI + 1) / 2;
            v = (v + t * 0.18) % 1;
          }
          const threshold = (bayer[y & 7][x & 7] + 0.5) / 64;
          const c = mid
            ? v > threshold + 0.33
              ? fg
              : v > threshold - 0.0
                ? mid
                : bg
            : v > threshold
              ? fg
              : bg;
          const i = (y * width + x) * 4;
          img.data[i] = c[0];
          img.data[i + 1] = c[1];
          img.data[i + 2] = c[2];
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    if (reduced) {
      render(stopAt);
      return;
    }

    const tick = (now: number) => {
      const elapsed = (now - start) / 1000;
      const u = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - u, 5);
      render(eased * stopAt);
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height, mode, duration, stopAt, bg, fg, mid]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{
        width: width * scale,
        height: height * scale,
        imageRendering: "pixelated",
        display: "block",
        borderRadius: rounded,
      }}
    />
  );
}
