"use client";
import { ArrowUpRight } from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";
import { DiscordIcon, GithubIcon, toolIcons } from "./tool-icons";

type Status = "shipped" | "wip" | "planned";

type Plugin = {
  name: string;
  label?: string;
  description: string;
  status: Status;
  color: string;
  repo: string;
};

const plugins: Plugin[] = [
  {
    name: "twitter",
    label: "Twitter / X",
    description: "Import Twitter exports & individual tweets.",
    status: "shipped",
    color: "#000000",
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
    label: "URL Scraper",
    description: "Scrape any URL into a markdown entry.",
    status: "wip",
    color: "#9CA3AF",
    repo: "https://github.com/dither-plugins/url-scraper",
  },
  {
    name: "imessage",
    label: "iMessage",
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
    label: "RSS",
    description: "Pull any RSS / Atom feed.",
    status: "planned",
    color: "#F26522",
    repo: "https://github.com/dither-plugins/rss",
  },
];

const REQUEST_PLUGIN_URL = "https://github.com/janniks/dither/discussions/1";
const PLUGINS_GITHUB_URL = "https://github.com/dither-plugins";
// placeholder invite until the real Discord exists
const DISCORD_URL = "https://discord.gg/dither";


export function WaveRow() {
  return (
    <section
      id="plugins"
      className="bg-fd-muted/10 mt-10 flex scroll-mt-24 flex-col gap-10 rounded-[36px] border p-6 md:rounded-[40px] md:p-8"
    >
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
            Index your data.
          </h2>
          <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
            Plugins pull from feeds, folders, and APIs into your collections.
            Each is a Deno script that runs only with the permissions you
            grant.
          </p>
          <div className="mt-1 flex items-center justify-end gap-3">
            <a
              href={PLUGINS_GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Plugins on GitHub"
              className="text-fd-muted-foreground hover:text-fd-foreground inline-flex h-8 w-8 items-center justify-center rounded-full"
            >
              <GithubIcon size={18} />
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Join the Discord"
              className="text-fd-muted-foreground hover:text-fd-foreground inline-flex h-8 w-8 items-center justify-center rounded-full"
            >
              <DiscordIcon size={18} />
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {plugins.map((p) => (
          <div
            key={p.name}
            className={`border bg-fd-card flex flex-col gap-3 rounded-[14px] p-4 ${
              p.status === "planned" ? "opacity-60" : ""
            } ${p.status === "wip" ? "opacity-80" : ""}`}
          >
            <div className="flex items-center gap-3">
              {(() => {
                const Icon = toolIcons[p.name as keyof typeof toolIcons];
                return (
                  <span
                    aria-hidden
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-white"
                    style={{ backgroundColor: p.color }}
                  >
                    {Icon ? <Icon size={16} /> : p.name[0]}
                  </span>
                );
              })()}
              <span
                className={`text-fd-foreground min-w-0 truncate text-[14px] font-semibold ${p.label ? "" : "capitalize"}`}
              >
                {p.label ?? p.name.replaceAll("-", " ")}
              </span>
              {p.status === "planned" && (
                <span className="bg-fd-muted text-fd-muted-foreground border-fd-border ml-auto hidden shrink-0 whitespace-nowrap items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase sm:inline-flex">
                  Coming soon
                </span>
              )}
            </div>
            <p className="text-fd-muted-foreground text-[13px] leading-[20px]">
              {p.description}
            </p>
          </div>
        ))}
      </div>

      <p className="text-fd-muted-foreground -mt-6 text-right text-[13px] leading-[20px]">
        Missing a source?{" "}
        <a
          href={REQUEST_PLUGIN_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground inline-flex items-center gap-1 font-medium"
        >
          Request a plugin
          <ArrowUpRight size={12} />
        </a>
      </p>
    </section>
  );
}
