"use client";
import { motion, useReducedMotion } from "motion/react";

const INK = "#ef8a8a";

// Loose hand-drawn "& search" — two strokes: the ampersand, then a cursive
// "search" scrawl. Not typographically exact on purpose; it should read as a
// margin note scribbled in red pen.
const STROKES = [
  // ampersand
  "M22 30c-4-5-9-5-11-1-2 4 2 7 6 10 4 3 8 6 7 10-1 4-7 4-9 1-2-4 1-9 6-13 4-3 7-5 9-8",
  // "search" as one continuous cursive run
  "M40 26c-4-3-11-3-12 2-1 4 5 5 8 7 3 2 3 6-1 7-4 1-7-2-7-4m14 2c2-4 6-6 8-4 2 2-3 5-8 6 0 3 3 5 6 3m4-1c1-4 5-8 7-6 2 1-1 5-3 8 2 2 4 0 5-2m1 2c0-4 3-8 6-8m2 8c1-4 4-7 6-6 2 1 0 4-3 5-3 1-3 3-1 4 2 1 4-1 5-3m2 2c1-4 4-8 6-7 1 1 0 2-1 3",
];

export function HandSearch({ className }: { className?: string }) {
  const reduced = useReducedMotion();

  return (
    <span aria-hidden className={className}>
      <svg
        className="pointer-events-none -rotate-6"
        fill="none"
        height="52"
        stroke={INK}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.5"
        viewBox="0 0 100 52"
        width="100"
      >
        <title>and search</title>
        {STROKES.map((d, i) => (
          <motion.path
            animate={{ pathLength: 1 }}
            d={d}
            initial={reduced ? false : { pathLength: 0 }}
            key={d}
            transition={{
              duration: i === 0 ? 0.25 : 0.45,
              delay: 0.6 + i * 0.25,
              ease: "easeOut",
            }}
          />
        ))}
      </svg>
    </span>
  );
}
