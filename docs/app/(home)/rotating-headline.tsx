"use client";
import { LayoutGroup, motion } from "motion/react";
import { DM_Serif_Text } from "next/font/google";
import TextRotate from "@/lib/text-rotate";

const serif = DM_Serif_Text({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

export function RotatingHeadline() {
  return (
    <h1
      style={{
        fontSize: "clamp(44px, 7vw, 72px)",
        lineHeight: 1,
        fontWeight: 650,
        letterSpacing: "-0.05em",
      }}
    >
      <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>
        <LayoutGroup>
          <motion.span style={{ display: "flex", whiteSpace: "pre" }} layout>
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
              mainClassName={`${serif.className} text-fd-background bg-fd-foreground px-2 sm:px-3 md:px-4 overflow-hidden py-0.5 sm:py-1 md:py-2 justify-center rounded-lg`}
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
          </motion.span>
        </LayoutGroup>
      </span>
      <span>as markdown</span>
    </h1>
  );
}
