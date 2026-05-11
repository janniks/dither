export function ArchitectureDiagram() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          The whole stack on one page.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          A wrapper around qmd. The CLI, the daemon, the MCP server, and the
          Deno plugin runtime all talk to the same index. The index lives next
          to your markdown.
        </p>
      </div>
      <div className="border bg-fd-card overflow-hidden rounded-[20px] p-6">
        <pre className="text-fd-foreground overflow-auto text-[12px] leading-[18px] font-mono">
{`           ┌──────────────────────────────┐
           │   markdown on disk           │
           │   ~/notes/**/*.md            │
           └──────────────┬───────────────┘
                          │
                          ▼
           ┌──────────────────────────────┐
           │   qmd index                  │
           │   ~/notes/.dither/index.qmd  │
           └──────────────┬───────────────┘
                          │
                          ▼
           ┌──────────────────────────────┐
           │   dither core                │
           └──┬──────┬──────┬──────┬──────┘
              │      │      │      │
        ┌─────▼─┐ ┌──▼──┐ ┌─▼───┐ ┌▼────────┐
        │  CLI  │ │ MCP │ │daemon│ │ plugins │
        │       │ │ srv │ │ +cron│ │ (Deno)  │
        │       │ │     │ │ +fs  │ │ sandbox │
        └───────┘ └─────┘ └──────┘ └─────────┘`}
        </pre>
      </div>
    </section>
  );
}
