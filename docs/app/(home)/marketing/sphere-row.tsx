"use client";
import { Dithering } from "@paper-design/shaders-react";

export function SphereRow() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <h2 className="text-4xl font-[650] leading-[1.05] tracking-[-0.03em]">
          Your data has a center now.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          Every note, page, message, bookmark — collected, indexed, and
          searchable from one CLI. Local-first, sandboxed, yours.
        </p>
      </div>
      <div className="overflow-hidden rounded-full bg-black">
        <div className="aspect-square w-full">
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
