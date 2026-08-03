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
// the background through discrete bands of ordered-dither (8x8 Bayer) density —
// same pixel-dissolve language as the DiagonalEdgeStrips in the manifesto.
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

/** Coverage per band, outermost first. Discrete steps, not a ramp. */
const BANDS = [0.12, 0.38, 0.66, 0.88];
const BAND_PX = 16;
const FADE_PX = BANDS.length * BAND_PX; // 64

/**
 * One tile of the dithered fade: FADE_PX wide, 8px tall, repeated vertically.
 * `flip` mirrors it for the right edge so both sides are symmetric.
 */
function ditherMaskUrl(flip: boolean): string {
  let d = "";
  for (let y = 0; y < 8; y++) {
    let runStart = -1;
    for (let x = 0; x <= FADE_PX; x++) {
      const sx = flip ? FADE_PX - 1 - x : x;
      const on =
        x < FADE_PX &&
        BANDS[Math.floor(sx / BAND_PX)] > (BAYER_8[y][sx & 7] + 0.5) / 64;
      if (on && runStart < 0) runStart = x;
      if (!on && runStart >= 0) {
        const w = x - runStart;
        d += `M${runStart} ${y}h${w}v1h-${w}z`;
        runStart = -1;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FADE_PX}" height="8" ` +
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
  maskPosition: "left top, right top, center",
  WebkitMaskPosition: "left top, right top, center",
  maskSize: `${FADE_PX}px 8px, ${FADE_PX}px 8px, 100% 100%`,
  WebkitMaskSize: `${FADE_PX}px 8px, ${FADE_PX}px 8px, 100% 100%`,
} as const;

export function ToolMarquee({ durationSeconds = 30 }: { durationSeconds?: number }) {
  return (
    <section className="flex w-full flex-col items-start">
      <style>{`
        @keyframes tool-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .tool-marquee-track {
          animation: tool-marquee ${durationSeconds}s linear infinite;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .tool-marquee-track { animation: none; }
        }
      `}</style>
      <div
        className="w-full overflow-hidden"
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
