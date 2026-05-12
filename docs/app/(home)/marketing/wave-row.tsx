"use client";
import { ArrowUpRight } from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";

type Status = "shipped" | "wip" | "planned";

type Plugin = {
  name: string;
  description: string;
  status: Status;
  color: string;
};

const plugins: Plugin[] = [
  {
    name: "twitter",
    description: "Import Twitter exports & individual tweets.",
    status: "shipped",
    color: "#1DA1F2",
  },
  {
    name: "pocket",
    description: "Sync Pocket bookmarks to a collection.",
    status: "shipped",
    color: "#D54D57",
  },
  {
    name: "raindrop",
    description: "Pull Raindrop.io bookmarks via API.",
    status: "shipped",
    color: "#4086D9",
  },
  {
    name: "url-scraper",
    description: "Scrape any URL into a markdown entry.",
    status: "wip",
    color: "#9CA3AF",
  },
  {
    name: "imessage",
    description: "Index local iMessage threads.",
    status: "wip",
    color: "#34C759",
  },
  {
    name: "browser-history",
    description: "Pull Chrome / Safari / Firefox history.",
    status: "planned",
    color: "#F59E0B",
  },
  {
    name: "slack",
    description: "Index a Slack workspace via the API.",
    status: "planned",
    color: "#4A154B",
  },
  {
    name: "rss",
    description: "Pull any RSS / Atom feed.",
    status: "planned",
    color: "#F26522",
  },
  {
    name: "reddit-saved",
    description: "Index your Reddit saved posts.",
    status: "planned",
    color: "#FF4500",
  },
];

const statusStyles: Record<Status, string> = {
  shipped: "bg-green-500/15 text-green-500 border-green-500/30",
  wip: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
  planned: "bg-fd-muted text-fd-muted-foreground border-fd-border",
};

export function WaveRow() {
  return (
    <section id="marketplace" className="flex scroll-mt-24 flex-col gap-10">
      <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-[1.05fr_1fr]">
        <div className="bg-black relative overflow-hidden rounded-[24px]">
          <div className="h-[280px] w-full md:h-[320px]">
            <Dithering
              width="100%"
              height="100%"
              colorBack="#000000"
              colorFront="#99D892"
              shape="wave"
              type="4x4"
              size={2}
              speed={1}
              scale={0.6}
            />
          </div>
          <a
            href="#marketplace"
            className="bg-fd-background/70 text-fd-foreground hover:text-fd-foreground absolute inset-0 m-auto inline-flex h-fit w-fit items-center gap-2 rounded-full border px-5 py-2.5 text-[16px] font-semibold no-underline backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]"
          >
            Plugin Market
            <ArrowUpRight size={18} />
          </a>
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-[650] tracking-[-0.02em]">
            Bring your data home.
          </h2>
          <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
            A plugin is a Deno script that adds entries into a collection.
            Pulls feeds, folders, APIs — and can update existing entries.
            Sandboxed by default, granted by you. Write your own in ~20 lines
            of TypeScript. Hands off.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {plugins.map((p) => (
          <div
            key={p.name}
            aria-disabled
            className={`border bg-fd-card flex flex-col gap-3 rounded-[14px] p-4 ${
              p.status === "planned" ? "opacity-50" : ""
            } ${p.status === "wip" ? "opacity-75" : ""}`}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="text-[15px] inline-flex h-8 w-8 items-center justify-center rounded-[10px] font-mono font-semibold text-white"
                style={{ backgroundColor: p.color }}
              >
                {p.name[0]}
              </span>
              <span className="text-[14px] font-semibold capitalize">
                {p.name.replaceAll("-", " ")}
              </span>
              <span
                className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${statusStyles[p.status]}`}
              >
                {p.status}
              </span>
            </div>
            <p className="text-fd-muted-foreground text-[13px] leading-[20px]">
              {p.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
