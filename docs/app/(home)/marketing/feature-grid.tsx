import { Boxes, Clock, ShieldCheck, Network } from "lucide-react";

const QMD_URL = "https://github.com/tobi/qmd";
const DENO_URL = "https://deno.com";
const TOBI_URL = "https://x.com/tobi";

type Feature = {
  icon: typeof Boxes;
  title: string;
  body: React.ReactNode;
  tag?: string;
};

const features: Feature[] = [
  {
    icon: Boxes,
    title: "Search by qmd",
    body: (
      <>
        Hybrid lexical + semantic search in one index, one file, built on{" "}
        <a
          href={QMD_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
        >
          qmd
        </a>{" "}
        by{" "}
        <a
          href={TOBI_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
        >
          Tobi Lütke
        </a>
        .
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: "Sandboxed with Deno",
    body: (
      <>
        Permissions are explicit and transparent. Third-party plugin code
        is secured through{" "}
        <a
          href={DENO_URL}
          target="_blank"
          rel="noreferrer"
          className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
        >
          Deno
        </a>
        .
      </>
    ),
  },
  {
    icon: Clock,
    title: "Scheduled & watched",
    body: "Optional crons, folder watchers, and activity triggers keep your index current on its own.",
  },
  {
    icon: Network,
    title: "Agent ready",
    body: "Expose your index to any agent — a SKILL.md and clean CLI output are all they need.",
  },
];

export function FeatureGrid() {
  return (
    <section className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {features.map((f) => {
        const Icon = f.icon;
        return (
          <div
            key={f.title}
            className="border bg-fd-card hover:border-fd-primary/40 flex flex-col gap-3 rounded-[16px] p-4 transition-colors duration-150 sm:p-5 md:p-4 lg:p-5"
          >
            <div className="bg-fd-muted text-fd-foreground flex h-10 w-10 items-center justify-center rounded-[12px]">
              <Icon size={18} strokeWidth={1.75} />
            </div>
            <div>
              <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold leading-tight tracking-[-0.01em]">
                {f.title}
                {f.tag ? (
                  <span className="border-fd-border text-fd-muted-foreground/70 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                    {f.tag}
                  </span>
                ) : null}
              </h3>
              <p className="text-fd-muted-foreground mt-2 text-[13px] leading-[20px] max-sm:line-clamp-2">
                {f.body}
              </p>
            </div>
          </div>
        );
      })}
    </section>
  );
}
