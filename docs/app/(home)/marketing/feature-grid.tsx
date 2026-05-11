import { Boxes, Clock, ShieldCheck, Network } from "lucide-react";

const QMD_URL = "https://github.com/janniks/qmd";

type Feature = {
  icon: typeof Boxes;
  title: string;
  body: React.ReactNode;
};

const features: Feature[] = [
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
        . Hybrid lexical + semantic in one index, one file.
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
    body: "Cron, fs watchers, or one-shot. Hands-off ingest, on your box.",
  },
  {
    icon: Network,
    title: "MCP-ready",
    body: "Expose the index to any agent. Same tools as your CLI.",
  },
];

export function FeatureGrid() {
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {features.map((f) => {
        const Icon = f.icon;
        return (
          <div
            key={f.title}
            className="border bg-fd-card hover:border-fd-primary/40 flex flex-col gap-3 rounded-[16px] p-5 transition-colors duration-150"
          >
            <div className="bg-fd-muted text-fd-foreground flex h-10 w-10 items-center justify-center rounded-[12px]">
              <Icon size={18} strokeWidth={1.75} />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">
                {f.title}
              </h3>
              <p className="text-fd-muted-foreground mt-2 text-[13px] leading-[20px]">
                {f.body}
              </p>
            </div>
          </div>
        );
      })}
    </section>
  );
}
