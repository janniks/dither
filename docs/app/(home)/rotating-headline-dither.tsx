"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Edge-dissolve overlay for the rotating headline chip.
 *
 * Renders as an absolutely-positioned sibling of the chip (never touching the
 * chip's own styles — a transform/filter there fights motion's layout
 * animations and makes the letters jiggle). On `pulse()` the chip's rounded
 * border briefly crumbles into bayer-dithered pixels — chip-coloured crumbs
 * outside the edge, background-coloured holes just inside it — then settles
 * back to the clean rounded-xl edge.
 */

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

/** dither cell size, CSS px */
const CELL = 3;
/** vertical bleed of the canvas past the chip box */
const EXT_Y = 10;
/** horizontal bleed — extra slack so a shrinking chip's animated box still fits */
const EXT_X = 56;
/** how far crumbs reach outside / holes reach inside the border */
const BAND_OUT = 7;
const BAND_IN = 6;
/** pulse length, ms */
const DURATION_MS = 460;
const RADIUS = 12; // rounded-xl

export type ChipDitherRef = { pulse: () => void };

/** distance to a rounded rect: positive outside, negative inside */
function roundedRectSd(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  r: number
): number {
  const rr = Math.min(r, halfW, halfH);
  const dx = Math.abs(x - cx) - (halfW - rr);
  const dy = Math.abs(y - cy) - (halfH - rr);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return (
    Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rr
  );
}

export const ChipDither = forwardRef<ChipDitherRef>(function ChipDither(
  _props,
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const startAtRef = useRef(0);
  const rafRef = useRef(0);
  const seedRef = useRef(0);

  useImperativeHandle(ref, () => ({
    pulse: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (
        typeof window === "undefined" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;

      seedRef.current = (seedRef.current + 1) % 8;
      startAtRef.current = performance.now();
      if (rafRef.current) return; // a loop is already running

      const chip = canvas.parentElement?.firstElementChild as HTMLElement | null;
      const wrapper = canvas.parentElement;
      if (!chip || !wrapper) return;

      const styles = getComputedStyle(document.documentElement);
      const fg =
        styles.getPropertyValue("--color-fd-foreground").trim() || "#0a0a0a";
      const bg =
        styles.getPropertyValue("--color-fd-background").trim() || "#ffffff";

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tick = (now: number) => {
        const p = (now - startAtRef.current) / DURATION_MS;
        const wrapRect = wrapper.getBoundingClientRect();
        const w = Math.max(1, Math.round(wrapRect.width + EXT_X * 2));
        const h = Math.max(1, Math.round(wrapRect.height + EXT_Y * 2));
        const cols = Math.max(1, Math.ceil(w / CELL));
        const rows = Math.max(1, Math.ceil(h / CELL));

        if (canvas.width !== cols || canvas.height !== rows) {
          canvas.width = cols;
          canvas.height = rows;
        }
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.clearRect(0, 0, cols, rows);

        if (p >= 1) {
          rafRef.current = 0;
          return;
        }

        // Chip box in canvas-local CSS px — measured live so the ring tracks
        // the chip while motion's layout animation resizes it.
        const chipRect = chip.getBoundingClientRect();
        const cx = chipRect.left - wrapRect.left + EXT_X + chipRect.width / 2;
        const cy = chipRect.top - wrapRect.top + EXT_Y + chipRect.height / 2;
        const halfW = chipRect.width / 2;
        const halfH = chipRect.height / 2;

        // spike then decay
        const amp = Math.sin(Math.PI * Math.max(0, Math.min(1, p))) ** 1.2;
        const seed = seedRef.current;

        for (let ry = 0; ry < rows; ry++) {
          const py = ry * CELL + CELL / 2;
          for (let rx = 0; rx < cols; rx++) {
            const px = rx * CELL + CELL / 2;
            const sd = roundedRectSd(px, py, cx, cy, halfW, halfH, RADIUS);
            const outside = sd > 0;
            const band = outside ? BAND_OUT : BAND_IN;
            const coverage = (1 - Math.abs(sd) / band) * amp;
            if (coverage <= 0) continue;
            const t = (bayer[(ry + seed) & 7][(rx + seed * 3) & 7] + 0.5) / 64;
            if (coverage <= t) continue;
            ctx.fillStyle = outside ? fg : bg;
            ctx.fillRect(rx, ry, 1, 1);
          }
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    },
  }));

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: -EXT_X,
        top: -EXT_Y,
        imageRendering: "pixelated",
      }}
    />
  );
});
