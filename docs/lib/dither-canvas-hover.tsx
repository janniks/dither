"use client";
import { useEffect, useRef, type RefObject } from "react";

type RGB = [number, number, number];
type Mode = "radial" | "linear" | "sweep";
type Phase = "idle" | "playing" | "settling";

type Props = {
  width: number;
  height: number;
  scale?: number;
  bg?: RGB;
  fg?: RGB;
  mid?: RGB;
  mode?: Mode;
  exitDelay?: number;
  settleDuration?: number;
  stopAt?: number;
  rounded?: number;
  triggerRef?: RefObject<HTMLElement | null>;
  onReady?: () => void;
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

export function DitherCanvasHover({
  width,
  height,
  scale = 2,
  bg = [10, 10, 10],
  fg = [255, 255, 255],
  mid,
  mode = "radial",
  exitDelay = 0.4,
  settleDuration = 1.4,
  stopAt = 2.6,
  rounded = 0,
  triggerRef,
  onReady,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = ctx.createImageData(width, height);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let phase: Phase = "idle";
    let phaseStartMs = 0;
    let tAtPhaseStart = stopAt;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    let alive = true;

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

    const currentT = (now: number) => {
      const dt = (now - phaseStartMs) / 1000;
      if (phase === "idle") return stopAt;
      if (phase === "playing") return tAtPhaseStart + dt;
      const u = Math.min(dt / settleDuration, 1);
      const eased = 1 - Math.pow(1 - u, 5);
      const t = tAtPhaseStart + (stopAt - tAtPhaseStart) * eased;
      if (u >= 1) {
        phase = "idle";
        phaseStartMs = now;
        tAtPhaseStart = stopAt;
      }
      return t;
    };

    const tick = (now: number) => {
      if (!alive) return;
      render(currentT(now));
      if (phase !== "idle") raf = requestAnimationFrame(tick);
    };

    const startPlaying = () => {
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
      const now = performance.now();
      tAtPhaseStart = currentT(now);
      phase = "playing";
      phaseStartMs = now;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };

    const startSettling = () => {
      const now = performance.now();
      tAtPhaseStart = currentT(now);
      phase = "settling";
      phaseStartMs = now;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };

    const onEnter = () => {
      if (reduced) return;
      startPlaying();
    };
    const onLeave = () => {
      if (reduced) return;
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = setTimeout(() => {
        exitTimer = null;
        startSettling();
      }, exitDelay * 1000);
    };

    const trigger: HTMLElement = triggerRef?.current ?? wrap;
    trigger.addEventListener("pointerenter", onEnter);
    trigger.addEventListener("pointerleave", onLeave);

    render(stopAt);
    onReady?.();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (exitTimer) clearTimeout(exitTimer);
      trigger.removeEventListener("pointerenter", onEnter);
      trigger.removeEventListener("pointerleave", onLeave);
    };
  }, [width, height, mode, exitDelay, settleDuration, stopAt, bg, fg, mid, triggerRef]);

  return (
    <span
      ref={wrapRef}
      style={{
        display: "inline-block",
        borderRadius: rounded,
        overflow: "hidden",
        lineHeight: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width: width * scale,
          height: height * scale,
          imageRendering: "pixelated",
          display: "block",
        }}
      />
    </span>
  );
}
