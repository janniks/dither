const QMD_URL = "https://github.com/janniks/qmd";

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
        If you don&apos;t need that, use qmd directly.
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
    q: "Encryption at rest?",
    a: "Use FileVault, LUKS, or your platform's equivalent. dither doesn't reinvent the wheel — your filesystem already does it well.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="flex scroll-mt-24 flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Questions a skeptic asks.
        </h2>
      </div>
      <div className="border bg-fd-card divide-y divide-fd-border rounded-[16px]">
        {items.map((item) => (
          <details key={item.q} className="group p-5">
            <summary className="cursor-pointer list-none text-[15px] font-semibold">
              <span className="text-fd-muted-foreground mr-2 inline-block group-open:rotate-90 transition-transform">
                ›
              </span>
              {item.q}
            </summary>
            <div className="text-fd-muted-foreground mt-3 ml-5 text-[14px] leading-[22px]">
              {item.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
