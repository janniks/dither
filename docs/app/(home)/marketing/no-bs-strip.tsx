export function NoBsStrip() {
  return (
    <section className="flex justify-center">
      <div className="border-y border-fd-border max-w-[760px] py-8">
        <p className="text-fd-foreground text-[20px] leading-[30px] font-medium tracking-[-0.01em]">
          A{" "}
          <span className="text-fd-foreground/60 font-normal">qmd wrapper</span>{" "}
          with a{" "}
          <span className="text-fd-foreground/60 font-normal">
            sandboxed plugin runtime
          </span>
          .{" "}
          <span className="text-fd-foreground/60 font-normal">
            No SaaS. No telemetry.
          </span>{" "}
          Markdown on disk; the index is a single qmd file you can{" "}
          <code className="bg-fd-muted text-fd-foreground rounded-md px-1.5 py-0.5 font-mono text-[16px]">
            rm
          </code>
          .
        </p>
      </div>
    </section>
  );
}
