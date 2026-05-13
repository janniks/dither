"use client";
import { Dithering } from "@paper-design/shaders-react";

export function SphereRow() {
  return (
    // Always side-by-side. Sphere uses explicit size at every breakpoint so
    // the rounded-full container stays a circle, not a vertically-stretched
    // pill. Text first, sphere after — flex justify-around so both sit closer
    // to the centre instead of being pushed to the outer edges.
    <section className="flex flex-col items-center justify-around gap-6 sm:flex-row sm:gap-6 md:gap-12">
      <div className="flex flex-col gap-2 sm:gap-3 md:gap-5">
        <h2 className="text-[22px] leading-[1.1] font-[650] tracking-[-0.03em] sm:text-3xl md:text-4xl md:leading-[1.05]">
          Your data has a center now.
        </h2>
        <p className="text-fd-muted-foreground text-[13px] leading-[18px] sm:text-[14px] sm:leading-[20px] md:max-w-[420px] md:text-[16px] md:leading-[26px]">
          Save the things you don&apos;t want to lose and find them again. One
          local index, designed to outlive any service or app you&apos;ve
          used.
        </p>
      </div>
      <div className="bg-black size-32 shrink-0 overflow-hidden rounded-full sm:size-40 md:size-[200px]">
        <Dithering
          width="100%"
          height="100%"
          colorBack="#000000"
          colorFront="#4AB5EC"
          shape="sphere"
          type="8x8"
          size={2}
          speed={1}
          scale={0.6}
        />
      </div>
    </section>
  );
}
