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

const FADE_MASK =
  "linear-gradient(to right, transparent, black 10%, black 90%, transparent)";

export function ToolMarquee({ durationSeconds = 30 }: { durationSeconds?: number }) {
  return (
    <section className="flex w-full flex-col items-start gap-4">
      <p className="text-fd-muted-foreground text-[13px] font-medium tracking-wide">
        Connect the tools you already use
      </p>
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
        style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
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
