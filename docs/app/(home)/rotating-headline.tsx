"use client";
import { LayoutGroup, motion } from "motion/react";
import { useCallback, useRef } from "react";
import TextRotate from "@/lib/text-rotate";
import { ChipDither, type ChipDitherRef } from "./rotating-headline-dither";

export function RotatingHeadline() {
  const ditherRef = useRef<ChipDitherRef>(null);
  // Imperative on purpose — re-rendering this component mid-rotation would
  // disturb motion's layout animations.
  const pulse = useCallback(() => ditherRef.current?.pulse(), []);

  return (
    <h1
      // Smaller on mobile (default + sm), original clamp on md+ so wide
      // viewports stay identical. Mobile splits the headline onto 3 lines
      // instead of 2 (Archive all your / chip / as markdown).
      className="text-[clamp(36px,9.5vw,48px)] leading-[1.05] font-[650] tracking-[-0.04em] sm:text-[44px] sm:tracking-[-0.05em] md:leading-none md:text-[clamp(44px,7vw,64px)]"
    >
      <span className="flex flex-wrap items-center">
        <LayoutGroup>
          <motion.span
            className="flex flex-wrap items-center whitespace-pre sm:flex-nowrap"
            layout
          >
            <motion.span
              className="pt-0.5 sm:pt-1 md:pt-2"
              layout
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
            >
              Archive all{" "}
            </motion.span>
            {/* xs-only break — forces "your [chip]" to the next line below "Access all" */}
            <span aria-hidden className="basis-full sm:hidden" />
            <motion.span
              className="pt-0.5 sm:pt-1 md:pt-2"
              layout
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
            >
              your{" "}
            </motion.span>
            {/* relative wrapper: hosts the dither overlay as a sibling of the
                chip, without touching the chip's own (layout-animated) styles */}
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
                  // (no translateZ — a static transform here conflicts with motion's
                  // layout animations and makes sibling letters jiggle)
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
                onNext={pulse}
                as="span"
              />
              <ChipDither ref={ditherRef} />
            </span>
          </motion.span>
        </LayoutGroup>
      </span>
      <span>as markdown</span>
    </h1>
  );
}
