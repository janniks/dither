export function NoBsStrip() {
  return (
    <section className="flex justify-center">
      <div className="border-y border-fd-border max-w-[760px] py-8">
        <p className="text-fd-foreground text-balance text-[20px] leading-[30px] font-medium tracking-[-0.01em]">
          <span className="text-fd-foreground/60 font-normal">Open source.</span>{" "}
          <span className="text-fd-foreground/60 font-normal">Sandboxed.</span>{" "}
          Your files stay markdown. Nobody can rugpull your data.
        </p>
      </div>
    </section>
  );
}
