"use client";

import { useState } from "react";
import { motion } from "motion/react";

// Collapses tall content to a fixed height with a fade-out, expanding to its
// natural height on click. Height is animated so nothing jumps.
export function ShowMore({
  collapsedHeight = 180,
  children,
}: {
  collapsedHeight?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Expanded: pull the wrapper's 20px bottom padding back to ~10px.
  return (
    <div className={open ? "relative -mb-2.5" : "relative"}>
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : collapsedHeight }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        className="relative overflow-hidden"
      >
        {children}
        {open ? null : (
          <div className="to-fd-card pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent" />
        )}
      </motion.div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-fd-muted-foreground hover:text-fd-foreground mt-2 w-full text-center font-mono text-[12px]"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
