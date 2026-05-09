"use client";
import { useEffect, useRef } from "react";

type RGB = [number, number, number];
type Mode = "erode" | "splatter" | "both";

type Props = {
  text: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: RGB;
  mode?: Mode;
  startFrac?: number;
  splatterPx?: number;
  // Cell size of the dither pattern in CSS pixels. 1 = fine (1px cells),
  // 2/3/4 = chunky retro look. Independent of glyph crispness.
  cellSize?: number;
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

export function DitherText({
  text,
  fontSize = 96,
  fontWeight = 700,
  fontFamily = "Inter, system-ui, sans-serif",
  color = [10, 10, 10],
  mode = "erode",
  startFrac = 0.5,
  splatterPx = 40,
  cellSize = 2,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Cell size in device pixels — keeps the dither chunky regardless of DPR.
    const cell = Math.max(1, Math.round(cellSize * dpr));

    // Glyphs render at full device resolution → crisp on retina.
    const renderFontSize = fontSize * dpr;

    ctx.font = `${fontWeight} ${renderFontSize}px ${fontFamily}`;
    const m = ctx.measureText(text);
    const splatter =
      mode === "splatter" || mode === "both"
        ? Math.ceil(splatterPx * dpr)
        : Math.ceil(4 * dpr);
    const w = Math.ceil(m.width + splatter);
    const h = Math.ceil(renderFontSize * 1.25);

    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;

    ctx.font = `${fontWeight} ${renderFontSize}px ${fontFamily}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = `rgb(${color.join(",")})`;
    ctx.fillText(text, 0, renderFontSize);

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const textW = m.width;

    const isText = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      isText[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    }

    const doErode = mode === "erode" || mode === "both";
    const doSplatter = mode === "splatter" || mode === "both";

    if (doErode) {
      const startX = startFrac * textW;
      const span = Math.max(1, textW - startX);
      for (let y = 0; y < h; y++) {
        const by = Math.floor(y / cell) & 7;
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (!isText[idx]) continue;
          const bx = Math.floor(x / cell) & 7;
          const t = Math.max(0, Math.min(1, (x - startX) / span));
          const keep = 1 - t;
          const threshold = (bayer[by][bx] + 0.5) / 64;
          if (keep < threshold) data[idx * 4 + 3] = 0;
        }
      }
    }

    if (doSplatter) {
      const bleed = Math.ceil(splatterPx * dpr);
      // Walk in cells so splatter pixels align with the dither grid.
      for (let y = 0; y < h; y += cell) {
        // Find rightmost original text pixel in this cell row band.
        let xR = -1;
        const yEnd = Math.min(h, y + cell);
        for (let x = w - 1; x >= 0 && xR < 0; x--) {
          for (let yy = y; yy < yEnd; yy++) {
            if (isText[yy * w + x]) {
              xR = x;
              break;
            }
          }
        }
        if (xR < 0) continue;
        const by = Math.floor(y / cell) & 7;
        for (let x = xR + 1; x < Math.min(w, xR + bleed + 1); x += cell) {
          const t = (x - xR) / bleed;
          const density = (1 - t) * 0.7;
          const bx = Math.floor(x / cell) & 7;
          const threshold = (bayer[by][bx] + 0.5) / 64;
          if (density > threshold) {
            // Fill the whole cell so the splatter "pixel" is chunky.
            for (let yy = y; yy < yEnd; yy++) {
              for (let xx = x; xx < Math.min(w, x + cell); xx++) {
                const idx = yy * w + xx;
                data[idx * 4] = color[0];
                data[idx * 4 + 1] = color[1];
                data[idx * 4 + 2] = color[2];
                data[idx * 4 + 3] = 255;
              }
            }
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [text, fontSize, fontWeight, fontFamily, color, mode, startFrac, splatterPx, cellSize]);

  return (
    <canvas
      ref={ref}
      style={{
        imageRendering: "pixelated",
        display: "block",
      }}
    />
  );
}
