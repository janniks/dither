export function NoBsStrip() {
  return (
    <section className="border-y border-fd-border/60 py-6">
      <p className="text-fd-foreground max-w-[820px] text-[17px] font-medium leading-[26px]">
        A qmd wrapper with a sandboxed plugin runtime. No SaaS. No telemetry.
        Markdown on disk; the index is a single qmd file you can{" "}
        <code className="bg-fd-muted text-fd-foreground rounded px-1.5 py-0.5 font-mono text-[14px]">
          rm
        </code>
        .
      </p>
    </section>
  );
}
