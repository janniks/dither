"use client";
import { Dithering } from "@paper-design/shaders-react";

const chips = [
  { name: "twitter", color: "#1DA1F2" },
  { name: "pocket", color: "#D54D57" },
  { name: "raindrop", color: "#4086D9" },
];

export function WaveRow() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-[1.05fr_1fr]">
      <div className="bg-black overflow-hidden rounded-[24px]">
        <div className="h-[280px] w-full md:h-[320px]">
          <Dithering
            width="100%"
            height="100%"
            colorBack="#000000"
            colorFront="#ff5d2e"
            shape="wave"
            type="4x4"
            size={2}
            speed={1}
            scale={0.6}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Pull the world in.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          A plugin is a Deno script that drops entries into a collection. Pull
          a feed, a folder, an API. Sandboxed by default, granted by you.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {chips.map((c) => (
            <span
              key={c.name}
              className="border bg-fd-card text-fd-foreground inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-medium"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              {c.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
