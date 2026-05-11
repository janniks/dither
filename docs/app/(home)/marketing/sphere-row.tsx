"use client";
import { Dithering } from "@paper-design/shaders-react";

export function SphereRow() {
  return (
    <section className="grid grid-cols-1 items-center gap-10 md:grid-cols-[1fr_1.1fr] md:gap-12">
      <div className="flex flex-col gap-5">
        <h2 className="text-4xl font-[650] leading-[1.05] tracking-[-0.03em] md:text-5xl">
          Your data has a center now.
        </h2>
        <p className="text-fd-muted-foreground text-[16px] leading-[26px] md:max-w-[420px]">
          Every note, page, message, bookmark — collected, indexed, and
          searchable from one CLI. Local-first, sandboxed, yours.
        </p>
      </div>
      <div className="flex justify-center md:justify-end">
        <div className="bg-black aspect-square w-full max-w-[440px] overflow-hidden rounded-full">
          <Dithering
            width="100%"
            height="100%"
            colorBack="#000000"
            colorFront="#00b3ff"
            shape="sphere"
            type="8x8"
            size={2}
            speed={1}
            scale={0.6}
          />
        </div>
      </div>
    </section>
  );
}
