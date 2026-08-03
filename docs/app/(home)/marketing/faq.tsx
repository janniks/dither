const QMD_URL = "https://github.com/tobi/qmd";

const items = [
  {
    q: "Why not just use qmd?",
    a: (
      <>
        You can — and it&apos;s great.{" "}
        <a
          href={QMD_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
        >
          qmd
        </a>{" "}
        is an excellent, agentic RAG index, and dither is honestly just a
        wrapper around it. I was building similar RAG applications as
        alternatives, decided to cut my losses, and wrapped qmd instead.
        dither adds the file-management layer around it: collections,
        plugins, scheduling, watching, and a CLI that ties it all together.
        The plugin runtime is where most of the work went — every plugin
        is a Deno subprocess started with explicit{" "}
        <code className="bg-fd-muted text-fd-foreground rounded-md px-1 py-0.5 font-mono text-[13px]">
          --allow-read
        </code>{" "}
        /{" "}
        <code className="bg-fd-muted text-fd-foreground rounded-md px-1 py-0.5 font-mono text-[13px]">
          --allow-write
        </code>{" "}
        /{" "}
        <code className="bg-fd-muted text-fd-foreground rounded-md px-1 py-0.5 font-mono text-[13px]">
          --allow-net
        </code>{" "}
        flags derived from grants you approve at install time, scoped to the
        paths and hosts that plugin actually needs. Nothing in the runtime is
        ambient: a plugin can&apos;t read another plugin&apos;s collection,
        can&apos;t escape its sandbox, and can&apos;t silently broaden its
        grants — any change forces a reinstall and re-approval. If you
        don&apos;t need any of that, use qmd directly.
      </>
    ),
  },
  {
    q: "Does dither send telemetry?",
    a: "No. The CLI runs locally, the daemon runs locally, and plugins only reach networks they're explicitly granted.",
  },
  {
    q: "Can plugins exfiltrate my data?",
    a: "Each plugin runs in a Deno subprocess started with explicit --allow-read / --allow-write / --allow-env / --allow-net flags derived from the grants accepted at install time. Grants are stored per plugin in ~/.dither/grants/<plugin>.json. Anything not in those flags is denied by the runtime; a plugin that requests new permissions has to be reinstalled and re-approved.",
  },
    {
    q: "Can I run scheduled plugins on a headless box?",
    a: "Yes. `dither daemon start` spawns a detached process that runs the scheduler and watcher loops; `dither daemon stop` and `dither daemon status` manage it. For auto-start on boot, wrap it in systemd / launchd in the usual way.",
  },
  {
    q: "Will I get rugpulled?",
    a: "No backend, no account, no telemetry. The CLI is MIT-licensed and the index is just markdown files on your disk — you can read them with anything, including without dither. The core stays free and open source forever. If paid addons ever happen (e.g. a sync service to your phone), they'll be optional and base dither won't change.",
  },
  {
    q: "Does it play nice with Obsidian (or my existing markdown folder)?",
    a: "Yes. dither operates on plain markdown files on disk; it never moves or deletes them. Point a collection at your Obsidian vault (or any folder) and it indexes in place. Plugins can update entries if you wire them to existing files, but you can also set them up against a separate collection so nothing in your vault is ever touched.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="flex scroll-mt-24 flex-col gap-6">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Frequently asked questions
        </h2>
      </div>
      <div className="border bg-fd-card divide-y divide-fd-border rounded-[16px]">
        {items.map((item) => (
          <details key={item.q} className="group">
            <summary className="cursor-pointer list-none p-5 text-[15px] font-semibold">
              <span className="text-fd-muted-foreground mr-2 inline-block group-open:rotate-90 transition-transform">
                ›
              </span>
              {item.q}
            </summary>
            <div className="text-fd-muted-foreground px-5 pb-5 ml-5 text-[14px] leading-[22px]">
              {item.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
