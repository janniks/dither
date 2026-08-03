"use client";
import { ArrowUpRight, Plus } from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";
import { toolIcons } from "./tool-icons";

type Status = "shipped" | "wip" | "planned";

type Plugin = {
  name: string;
  description: string;
  status: Status;
  color: string;
  repo: string;
};

const plugins: Plugin[] = [
  {
    name: "twitter",
    description: "Import Twitter exports & individual tweets.",
    status: "shipped",
    color: "#1DA1F2",
    repo: "https://github.com/dither-plugins/twitter",
  },
  {
    name: "pocket",
    description: "Sync Pocket bookmarks to a collection.",
    status: "shipped",
    color: "#D54D57",
    repo: "https://github.com/dither-plugins/pocket",
  },
  {
    name: "raindrop",
    description: "Pull Raindrop.io bookmarks via API.",
    status: "shipped",
    color: "#4086D9",
    repo: "https://github.com/dither-plugins/raindrop",
  },
  {
    name: "url-scraper",
    description: "Scrape any URL into a markdown entry.",
    status: "wip",
    color: "#9CA3AF",
    repo: "https://github.com/dither-plugins/url-scraper",
  },
  {
    name: "imessage",
    description: "Index local iMessage threads.",
    status: "wip",
    color: "#34C759",
    repo: "https://github.com/dither-plugins/imessage",
  },
  {
    name: "browser-history",
    description: "Pull Chrome / Safari / Firefox history.",
    status: "planned",
    color: "#F59E0B",
    repo: "https://github.com/dither-plugins/browser-history",
  },
  {
    name: "slack",
    description: "Index a Slack workspace via the API.",
    status: "planned",
    color: "#4A154B",
    repo: "https://github.com/dither-plugins/slack",
  },
  {
    name: "rss",
    description: "Pull any RSS / Atom feed.",
    status: "planned",
    color: "#F26522",
    repo: "https://github.com/dither-plugins/rss",
  },
];

const REQUEST_PLUGIN_URL = "https://github.com/janniks/dither/discussions/1";


export function WaveRow() {
  return (
    <section id="plugins" className="flex scroll-mt-24 flex-col gap-10">
      <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-[1.05fr_1fr] lg:gap-10">
        <div className="bg-black relative overflow-hidden rounded-[24px]">
          <div className="h-[232px] w-full lg:h-[248px]">
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
            href="#plugins"
            className="bg-fd-background/70 text-fd-foreground hover:text-fd-foreground absolute inset-0 m-auto inline-flex h-fit w-fit items-center gap-2 rounded-full border px-5 py-2.5 text-[16px] font-semibold no-underline backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]"
          >
            Community Plugins
            <ArrowUpRight size={18} />
          </a>
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-[650] tracking-[-0.02em]">
            Secure the data that belongs to you.
          </h2>
          <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
            Plugins pull from feeds, folders, and APIs into your collections —
            each one a Deno script that runs only with the permissions you
            grant. Write your own in ~20 lines of TypeScript.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {plugins.map((p) => (
          <a
            key={p.name}
            href={p.repo}
            target="_blank"
            rel="noreferrer"
            className={`group border bg-fd-card hover:border-fd-primary/40 hover:bg-fd-accent/40 flex flex-col gap-3 rounded-[14px] p-4 no-underline transition-colors ${
              p.status === "planned" ? "opacity-60" : ""
            } ${p.status === "wip" ? "opacity-80" : ""}`}
          >
            <div className="flex items-center gap-3">
              {(() => {
                const Icon = toolIcons[p.name as keyof typeof toolIcons];
                return (
                  <span
                    aria-hidden
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-white"
                    style={{ backgroundColor: p.color }}
                  >
                    {Icon ? <Icon size={16} /> : p.name[0]}
                  </span>
                );
              })()}
              <span className="text-fd-foreground text-[14px] font-semibold capitalize">
                {p.name.replaceAll("-", " ")}
              </span>
              {p.status === "planned" && (
                <span className="bg-fd-muted text-fd-muted-foreground border-fd-border ml-auto hidden items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase sm:inline-flex">
                  Coming soon
                </span>
              )}
            </div>
            <p className="text-fd-muted-foreground text-[13px] leading-[20px]">
              {p.description}
            </p>
            <span className="text-fd-muted-foreground/70 group-hover:text-fd-foreground mt-auto inline-flex items-center gap-1 font-mono text-[11px] transition-colors">
              {p.repo.replace("https://", "")}
              <ArrowUpRight size={12} />
            </span>
          </a>
        ))}
        <a
          href={REQUEST_PLUGIN_URL}
          target="_blank"
          rel="noreferrer"
          className="border bg-fd-card hover:border-fd-primary/40 hover:bg-fd-accent/40 flex flex-col gap-3 rounded-[14px] p-4 no-underline transition-colors"
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="bg-fd-muted text-fd-muted-foreground inline-flex h-8 w-8 items-center justify-center rounded-[10px]"
            >
              <Plus size={18} strokeWidth={2} />
            </span>
            <span className="text-fd-foreground text-[14px] font-semibold">
              Request a plugin
            </span>
          </div>
          <p className="text-fd-muted-foreground text-[13px] leading-[20px]">
            Missing a source? Open a discussion and pitch it.
          </p>
        </a>
      </div>
    </section>
  );
}
