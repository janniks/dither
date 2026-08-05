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

// Pixelated page fold, top-right corner. FOLD px cut in STEP px stairs:
// the clip-path removes the corner (border included) and PixelFold draws the
// stepped flap in the border color along the cut edge.
const FOLD = 36;
const STEP = 3; // matches the dither cellPx and the 3px border

const FOLD_CLIP = `polygon(${[
  "0 0",
  `calc(100% - ${FOLD}px) 0`,
  ...Array.from({ length: FOLD / STEP }, (_, k) => [
    `calc(100% - ${FOLD - k * STEP}px) ${(k + 1) * STEP}px`,
    `calc(100% - ${FOLD - (k + 1) * STEP}px) ${(k + 1) * STEP}px`,
  ]).flat(),
  "100% 100%",
  "0 100%",
].join(", ")})`;

function PixelFold() {
  return (
    <svg
      aria-hidden
      className="absolute -top-[3px] -right-[3px]"
      width={FOLD}
      height={FOLD}
      viewBox={`0 0 ${FOLD} ${FOLD}`}
      shapeRendering="crispEdges"
    >
      {Array.from({ length: FOLD / STEP - 1 }, (_, k) => (
        <rect
          key={k}
          x={0}
          y={(k + 1) * STEP}
          width={(k + 1) * STEP}
          height={STEP}
          fill="var(--color-fd-border)"
          // bottom row darker — reads as the flap's underside shadow
          opacity={k === FOLD / STEP - 2 ? 0.95 : 0.6}
        />
      ))}
    </svg>
  );
}

export function Manifesto() {
  return (
    <section
      id="manifesto"
      className="flex scroll-mt-24 flex-col items-center py-14 md:py-20"
    >
      <article
        // `border-[3px] border-fd-border/60` is an experimental 3px border — remove freely
        className="bg-fd-card border-[3px] border-fd-border/60 relative max-w-[760px] overflow-hidden p-6 sm:p-8 md:p-12"
        style={{ borderRadius: 0, clipPath: FOLD_CLIP }}
      >
        <PixelFold />
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
