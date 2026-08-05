"use client";

// Static counterpart to ToolMarquee: the agents dither plugs into, plus a
// one-click copy of the SKILL.md an agent needs to drive the CLI. Deliberately
// not pill-shaped — a fanned stack of tilted tiles, so it reads as a different
// kind of thing than the plugin chips.
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { toolIcons } from "./tool-icons";

type AgentItem = {
  name: string;
  icon: keyof typeof toolIcons;
  tilt: string;
  size?: number;
};

const ICON_SIZE = 18;

const AGENTS: AgentItem[] = [
  { name: "Claude Code", icon: "claude-code", tilt: "-6deg" },
  { name: "Pi", icon: "pi", tilt: "4deg" },
  { name: "Codex", icon: "openai", tilt: "-3deg" },
  { name: "OpenCode", icon: "opencode", tilt: "5deg", size: 20 },
  { name: "Cursor", icon: "cursor", tilt: "-4deg" },
];

const SKILL_MD = `# dither

Search the user's personal library.

- \`dither search "<query>" -C\` — search all collections
- \`dither get <docid>\` — print a document
`;

const COPY_CLASSNAME =
  "border bg-fd-card hover:bg-fd-accent inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-[10px] px-4 py-3 text-sm font-medium transition-colors";

export function AgentsRow({
  // TEMPORARY: lets the hero CTA variant picker restyle/relabel the copy
  // button from outside. Defaults are the current design.
  copyClassName = COPY_CLASSNAME,
  copyLabel = "Copy prompt",
}: {
  copyClassName?: string;
  copyLabel?: string;
} = {}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(SKILL_MD);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex shrink-0 items-center pl-1">
        {AGENTS.map((agent, i) => {
          const Icon = toolIcons[agent.icon];
          return (
            <span
              key={agent.name}
              title={agent.name}
              className="border-fd-border bg-fd-card text-fd-foreground relative z-[var(--z)] -ml-2 inline-flex h-10 w-10 items-center justify-center rounded-[10px] border transition-transform duration-150 ease-out first:ml-0 [transform:translateY(0)_rotate(var(--tilt))] hover:z-20 hover:[transform:translateY(-3px)_rotate(calc(var(--tilt)*1.35))]"
              style={{ "--tilt": agent.tilt, "--z": i + 1 } as CSSProperties}
            >
              <Icon size={agent.size ?? ICON_SIZE} />
            </span>
          );
        })}
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy prompt"
        className={copyClassName}
      >
        <Copy size={14} />
        {/* both labels stacked in one grid cell — button width stays at the
            wider of the two, so toggling the copied state can't layout-shift */}
        <span className="grid text-center">
          <span className={copied ? "invisible" : ""} style={{ gridArea: "1/1" }}>
            {copyLabel}
          </span>
          <span className={copied ? "" : "invisible"} style={{ gridArea: "1/1" }}>
            Copied ✓
          </span>
        </span>
      </button>
    </div>
  );
}
