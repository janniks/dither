import { Boxes, Clock, ShieldCheck, Network } from "lucide-react";

const QMD_URL = "https://github.com/janniks/qmd";

const features = [
  {
    icon: Boxes,
    title: "qmd-powered",
    body: (
      <>
        A CLI wrapper around{" "}
        <a
          href={QMD_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
        >
          qmd
        </a>
        . Lexical + semantic in one index.
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: "Deno-sandboxed plugins",
    body: "Net / fs / env grants are explicit per plugin. Nothing implicit, ever.",
  },
  {
    icon: Clock,
    title: "Scheduled & watched",
    body: "Cron, fs watchers, or one-shot. Hands-off ingest.",
  },
  {
    icon: Network,
    title: "MCP-ready",
    body: "Expose your index to any agent. Same tools as your CLI.",
  },
];

export function FeatureGrid() {
  return (
    <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {features.map((f) => {
        const Icon = f.icon;
        return (
          <div
            key={f.title}
            className="border bg-fd-card flex flex-col gap-3 rounded-[16px] p-5"
          >
            <div className="bg-fd-muted text-fd-muted-foreground flex h-9 w-9 items-center justify-center rounded-[10px]">
              <Icon size={18} />
            </div>
            <h3 className="text-[15px] font-semibold leading-tight">
              {f.title}
            </h3>
            <p className="text-fd-muted-foreground text-[13px] leading-[20px]">
              {f.body}
            </p>
          </div>
        );
      })}
    </section>
  );
}
