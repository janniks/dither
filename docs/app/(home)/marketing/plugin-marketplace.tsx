type Status = "shipped" | "wip" | "planned";

type Plugin = {
  name: string;
  description: string;
  status: Status;
};

const plugins: Plugin[] = [
  { name: "twitter", description: "Import Twitter exports & individual tweets.", status: "shipped" },
  { name: "pocket", description: "Sync Pocket bookmarks to a collection.", status: "shipped" },
  { name: "raindrop", description: "Pull Raindrop.io bookmarks via API.", status: "shipped" },
  { name: "url-scraper", description: "Scrape any URL into a markdown entry.", status: "wip" },
  { name: "imessage", description: "Index local iMessage threads.", status: "wip" },
  { name: "browser-history", description: "Pull Chrome / Safari / Firefox history.", status: "planned" },
  { name: "slack", description: "Index a Slack workspace via the API.", status: "planned" },
  { name: "rss", description: "Pull any RSS / Atom feed.", status: "planned" },
  { name: "reddit-saved", description: "Index your Reddit saved posts.", status: "planned" },
];

const statusStyles: Record<Status, string> = {
  shipped: "bg-green-500/15 text-green-500 border-green-500/30",
  wip: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
  planned: "bg-fd-muted text-fd-muted-foreground border-fd-border",
};

export function PluginMarketplace() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          The plugin marketplace.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Real plugins, honest status. Write your own in ~50 lines of Deno.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plugins.map((p) => (
          <div
            key={p.name}
            className={`border bg-fd-card flex flex-col gap-2 rounded-[14px] p-4 ${
              p.status === "planned" ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold capitalize">
                {p.name.replaceAll("-", " ")}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${statusStyles[p.status]}`}
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
