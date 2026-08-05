"use client";
import TextRotate from "@/lib/text-rotate";

export function RotatingHeadline() {
  return (
    <h1
      // Smaller on mobile (default + sm), original clamp on md+ so wide
      // viewports stay identical. Mobile splits the headline onto 3 lines
      // instead of 2 (Archive all your / chip / as markdown).
      className="text-[clamp(36px,9.5vw,48px)] leading-[1.05] font-[650] tracking-[-0.04em] sm:text-[44px] sm:tracking-[-0.05em] md:leading-none md:text-[clamp(44px,7vw,64px)]"
    >
      {/* The static words are deliberately PLAIN spans — no `layout`, no
        LayoutGroup. With them in a LayoutGroup, motion re-measured every
        member on each frame of the chip's width spring and applied sub-pixel
        corrective transforms to text that never moves → the letter jiggle.
        The chip is the last element on its line, so its width change reflows
        nothing; only TextRotate itself needs `layout` (it has it internally). */}
      <span className="flex flex-wrap items-center whitespace-pre sm:flex-nowrap">
        <span className="pt-0.5 sm:pt-1 md:pt-2">Archive all </span>
        {/* xs-only break — forces "your [chip]" to the next line below "Archive all" */}
        <span aria-hidden className="basis-full sm:hidden" />
        <span className="pt-0.5 sm:pt-1 md:pt-2">your </span>
        <span className="relative inline-flex">
          <TextRotate
            texts={[
              "memories",
              "things ✦",
              "bookmarks",
              "✽ ideas",
              "notes",
              "thoughts",
              "answers",
            ]}
            mainClassName="font-[var(--font-dm-serif)] text-fd-background bg-fd-foreground px-3 sm:px-4 md:px-5 py-0.5 sm:py-1 md:py-2 justify-center rounded-xl overflow-hidden"
            // override TextRotate's internal flex-wrap + whitespace-pre-wrap
            style={{
              flexWrap: "nowrap",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-dm-serif), serif",
              // Safari anti-aliasing mitigations for transform-animated text
              backfaceVisibility: "hidden",
              WebkitFontSmoothing: "antialiased",
            }}
            staggerFrom="last"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "-120%" }}
            staggerDuration={0.025}
            splitLevelClassName="overflow-hidden pb-0.5 sm:pb-1 md:pb-1"
            transition={{ type: "spring", damping: 30, stiffness: 400 }}
            rotationInterval={2200}
            as="span"
          />
        </span>
      </span>
      <span>as markdown</span>
    </h1>
  );
}
