"use client";
import { LayoutGroup, motion } from "motion/react";
import TextRotate from "@/lib/text-rotate";

export function RotatingHeadline() {
  return (
    <h1
      className="font-[650] leading-none tracking-[-0.05em]"
      style={{ fontSize: "clamp(44px, 7vw, 72px)" }}
    >
      <span className="flex flex-wrap items-center">
        <LayoutGroup>
          <motion.span className="flex whitespace-pre" layout>
            <motion.span
              className="pt-0.5 sm:pt-1 md:pt-2"
              layout
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
            >
              Access all your{" "}
            </motion.span>
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
              mainClassName="font-[var(--font-dm-serif)] text-fd-background bg-fd-foreground px-3 sm:px-4 md:px-5 py-0.5 sm:py-1 md:py-2 justify-center rounded-xl"
              // override TextRotate's internal flex-wrap + whitespace-pre-wrap
              style={{
                flexWrap: "nowrap",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-dm-serif), serif",
              }}
              staggerFrom="last"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "-120%" }}
              staggerDuration={0.025}
              splitLevelClassName="pb-0.5 sm:pb-1 md:pb-1"
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
              rotationInterval={2200}
              as="span"
            />
          </motion.span>
        </LayoutGroup>
      </span>
      <span>as markdown</span>
    </h1>
  );
}
