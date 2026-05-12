import Image from "next/image";

type AgentItem = {
  name: string;
  src: string;
};

type AgentMarqueeProps = {
  rows?: AgentItem[][];
  durationSeconds?: number;
};

const DEFAULT_ROWS: AgentItem[][] = [
  [
    { name: "Claude Code", src: "/agents/claude.svg" },
    { name: "Cursor", src: "/agents/cursor.svg" },
    { name: "Codex", src: "/agents/openai.svg" },
    { name: "Copilot CLI", src: "/agents/copilot.svg" },
    { name: "Gemini CLI", src: "/agents/gemini.svg" },
    { name: "Continue", src: "/agents/continue.svg" },
    { name: "Cline", src: "/agents/cline.svg" },
    { name: "OpenCode", src: "/agents/opencode.svg" },
    { name: "Amp", src: "/agents/amp.svg" },
  ],
  [
    { name: "Cursor", src: "/agents/cursor.svg" },
    { name: "Copilot CLI", src: "/agents/copilot.svg" },
    { name: "OpenCode", src: "/agents/opencode.svg" },
    { name: "Cline", src: "/agents/cline.svg" },
    { name: "Claude Code", src: "/agents/claude.svg" },
    { name: "Continue", src: "/agents/continue.svg" },
    { name: "Codex", src: "/agents/openai.svg" },
    { name: "Gemini CLI", src: "/agents/gemini.svg" },
    { name: "Amp", src: "/agents/amp.svg" },
  ],
];

const FADE_MASK =
  "linear-gradient(to right, transparent, black 10%, black 90%, transparent)";

export function AgentMarquee({
  rows = DEFAULT_ROWS,
  durationSeconds = 25,
}: AgentMarqueeProps) {
  return (
    <section className="flex flex-col items-center gap-3 w-full">
      <style>{`
        @keyframes agent-marquee-left  { from { transform: translateX(0); }     to { transform: translateX(-50%); } }
        @keyframes agent-marquee-right { from { transform: translateX(-50%); }  to { transform: translateX(0); } }
        .agent-marquee-track {
          animation-duration: ${durationSeconds}s;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
        }
        .agent-marquee-track[data-dir="left"]  { animation-name: agent-marquee-left; }
        .agent-marquee-track[data-dir="right"] { animation-name: agent-marquee-right; }
        @media (prefers-reduced-motion: reduce) {
          .agent-marquee-track { animation: none; }
        }
      `}</style>

      {rows.map((items, rowIdx) => (
        <div
          key={rowIdx}
          className="w-full overflow-hidden"
          style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
        >
          <div
            className="flex w-max gap-3 agent-marquee-track"
            data-dir={rowIdx % 2 === 0 ? "left" : "right"}
          >
            {[...items, ...items].map((item, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-5 py-3 bg-white rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.04)] shrink-0 text-black text-sm"
              >
                <Image
                  src={item.src}
                  alt={item.name}
                  width={18}
                  height={18}
                  unoptimized
                />
                <span>{item.name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
