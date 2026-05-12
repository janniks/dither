// Manifesto text is copied verbatim from
// ../mmry-homepage-new/app/page.tsx ~lines 600-675 (per spec).
// User will edit "mmry" → "dither" references later.
import {
  DiagonalEdgeStrips,
  type DitherStripOpts,
} from "@/lib/dither-edge-strip";

const MANIFESTO_OPTS: DitherStripOpts = {
  thickness: 36,
  cellPx: 3,
  falloff: 0.45,
  acrossFalloff: 0.8,
  jitter: 0.15,
  densityScale: 1.25,
};

export function Manifesto() {
  return (
    <section
      id="manifesto"
      className="flex scroll-mt-24 flex-col items-center"
    >
      <article
        className="bg-fd-card relative max-w-[720px] overflow-hidden p-6 sm:p-8 md:p-12"
        style={{ borderRadius: 0 }}
      >
        <p className="text-fd-muted-foreground relative z-[1] text-[12px] font-semibold tracking-[0.12em] uppercase">
          Manifesto
        </p>
        <div className="text-fd-foreground relative z-[1] mt-6 space-y-3 text-[15px] leading-[24px] sm:space-y-4 sm:text-[16px] sm:leading-[26px] md:text-[18px] md:leading-[30px]">
          <p>Something happened to our digital memories.</p>
          <p>
            They used to belong to us. Photos on hard drives. Emails in
            folders. Bookmarks in browsers. You knew where things were because
            you put them there.
          </p>
          <p>
            Today,{" "}
            <Mark>our memories are scattered</Mark> across a thousand services.
            Your thoughts live in Notion&apos;s cloud. Your conversations in
            Slack&apos;s servers. Your inspirations on Twitter&apos;s
            timeline. Your discoveries buried in Reddit&apos;s endless scroll.
            Each platform holds a piece of your digital self hostage, locked
            behind their walls, searchable only by their rules, accessible
            only at their pleasure.
          </p>
          <p>
            You&apos;ve become a digital tenant, paying rent to access your
            own memories in houses you&apos;ll never own.
          </p>
          <p>
            Dither is a tool that works for you, not the other way around.
            Connect your services once. Search everything instantly. Keep
            control always.
          </p>
        </div>
        <DiagonalEdgeStrips opts={MANIFESTO_OPTS} />
      </article>
    </section>
  );
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <mark className="bg-yellow-200/30 text-fd-foreground rounded-md px-1.5 py-0.5 dark:bg-yellow-300/20">
      {children}
    </mark>
  );
}
