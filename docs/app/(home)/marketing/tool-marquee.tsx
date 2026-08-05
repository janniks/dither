// Marquee of the tools plugins connect to. Same animation approach as
// AgentMarquee, but chips use inline brand icons (tool-icons.tsx) instead of
// /public image assets.
import { toolIcons } from "./tool-icons";

type ToolItem = {
  name: string;
  icon: keyof typeof toolIcons;
  color: string;
};

const TOOLS: ToolItem[] = [
  { name: "Twitter / X", icon: "twitter", color: "#000000" },
  { name: "Pocket", icon: "pocket", color: "#D54D57" },
  { name: "Raindrop.io", icon: "raindrop", color: "#4086D9" },
  { name: "Obsidian", icon: "obsidian", color: "#7C3AED" },
  { name: "Slack", icon: "slack", color: "#4A154B" },
  { name: "RSS", icon: "rss", color: "#F26522" },
  { name: "iMessage", icon: "imessage", color: "#34C759" },
  { name: "Chrome", icon: "browser-history", color: "#F59E0B" },
];

// Dithered edge fade. Instead of a smooth alpha ramp, the chips dissolve into
// the background through a noisy dither: per-2px-cell threshold test against a
// continuous coverage ramp, so density rises smoothly with no band seams. The
// threshold mixes ordered Bayer with a seeded PRNG so it reads as noise rather
// than a grid — same pixel-dissolve language as the manifesto's edge strips.
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Size of one dither block, in CSS px. Threshold is sampled per block. */
const PIXEL = 2;
/** Total width of the edge fade. One coverage level per block column. */
const FADE_PX = 52;
const BLOCKS = FADE_PX / PIXEL; // 26 distinct density levels
/** Rows per animation frame; the noise repeats vertically at this period. */
const ROWS = 8;
const FRAME_PX = ROWS * PIXEL; // 16
/** Noise frames stacked vertically in one tile; stepped through for shimmer. */
const FRAMES = 4;
const TILE_PX = FRAME_PX * FRAMES; // 64
const FRAME_MS = 220;

/** Deterministic PRNG — SSR/client must generate byte-identical masks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Smoothstep coverage: 0 at the outer edge, 1 where the opaque core starts.
 * Quantized to BLOCKS levels so each block column sits on its own density
 * step — one dither pixel per transparency level across the fade.
 */
function coverage(bx: number): number {
  const t = (bx + 0.5) / BLOCKS;
  const s = t * t * (3 - 2 * t);
  return Math.round(s * BLOCKS) / BLOCKS;
}

/**
 * One tile of the dithered fade: FADE_PX wide, TILE_PX tall (FRAMES stacked
 * noise frames), repeated vertically. Each dither block is PIXEL×PIXEL.
 * `flip` mirrors it for the right edge so both sides are symmetric.
 */
function ditherMaskUrl(flip: boolean): string {
  const rand = mulberry32(0x51ed_7e5);
  // Pre-roll so the same cell gets the same jitter on both edges.
  const jitter: number[] = [];
  for (let i = 0; i < BLOCKS * ROWS * FRAMES; i++) jitter.push(rand());

  let d = "";
  for (let row = 0; row < ROWS * FRAMES; row++) {
    let runStart = -1;
    for (let bx = 0; bx <= BLOCKS; bx++) {
      const sbx = flip ? BLOCKS - 1 - bx : bx;
      const ordered = (BAYER_8[row & 7][sbx & 7] + 0.5) / 64;
      const noise = jitter[row * BLOCKS + sbx];
      const threshold = 0.55 * ordered + 0.45 * noise;
      const on = bx < BLOCKS && coverage(sbx) > threshold;
      if (on && runStart < 0) runStart = bx;
      if (!on && runStart >= 0) {
        const w = (bx - runStart) * PIXEL;
        d += `M${runStart * PIXEL} ${row * PIXEL}h${w}v${PIXEL}h-${w}z`;
        runStart = -1;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FADE_PX}" height="${TILE_PX}" ` +
    `shape-rendering="crispEdges"><path d="${d}"/></svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

const DITHER_LEFT = ditherMaskUrl(false);
const DITHER_RIGHT = ditherMaskUrl(true);
// Fully opaque core; the two dither tiles add the stepped edges on top
// (multiple mask layers composite additively by default).
const CORE = `linear-gradient(to right, transparent ${FADE_PX}px, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), transparent calc(100% - ${FADE_PX}px))`;

const FADE_MASK = {
  maskImage: `${DITHER_LEFT}, ${DITHER_RIGHT}, ${CORE}`,
  WebkitMaskImage: `${DITHER_LEFT}, ${DITHER_RIGHT}, ${CORE}`,
  maskRepeat: "repeat-y, repeat-y, no-repeat",
  WebkitMaskRepeat: "repeat-y, repeat-y, no-repeat",
  maskSize: `${FADE_PX}px ${TILE_PX}px, ${FADE_PX}px ${TILE_PX}px, 100% 100%`,
  WebkitMaskSize: `${FADE_PX}px ${TILE_PX}px, ${FADE_PX}px ${TILE_PX}px, 100% 100%`,
} as const;

export function ToolMarquee({ durationSeconds = 30 }: { durationSeconds?: number }) {
  return (
    <section className="flex w-full items-center gap-3">
      <style>{`
        @keyframes tool-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .tool-marquee-track {
          animation: tool-marquee ${durationSeconds}s linear infinite;
          will-change: transform;
        }
        @keyframes tool-marquee-dither {
          from {
            -webkit-mask-position: left top, right top, center;
            mask-position: left top, right top, center;
          }
          to {
            -webkit-mask-position: left -${TILE_PX}px, right -${TILE_PX}px, center;
            mask-position: left -${TILE_PX}px, right -${TILE_PX}px, center;
          }
        }
        .tool-marquee-mask {
          -webkit-mask-position: left top, right top, center;
          mask-position: left top, right top, center;
          animation: tool-marquee-dither ${FRAME_MS * FRAMES}ms steps(${FRAMES}) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .tool-marquee-track, .tool-marquee-mask { animation: none; }
        }
      `}</style>
      <div
        className="tool-marquee-mask min-w-0 flex-1 overflow-hidden"
        style={FADE_MASK}
      >
        <div className="tool-marquee-track flex w-max gap-3">
          {[...TOOLS, ...TOOLS].map((tool, i) => {
            const Icon = toolIcons[tool.icon];
            return (
              <div
                key={i}
                className="border-fd-border bg-fd-card text-fd-foreground flex shrink-0 items-center gap-2.5 rounded-full border px-4 py-2 text-[13px] font-medium"
              >
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-md text-white"
                  style={{ backgroundColor: tool.color }}
                >
                  <Icon size={12} />
                </span>
                {tool.name}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
