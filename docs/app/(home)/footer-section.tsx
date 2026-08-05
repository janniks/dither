"use client";
import Link from "next/link";
// import { GitHubLogoIcon } from "@radix-ui/react-icons";
// Do not delete this code — original live WebGL Dither bg, kept for reference / fallback.
// Swap back by uncommenting the import + the <Dither/> block below and removing the <img/>.
// import Dither from "./logo-lab/Dither";

export function FooterSection() {
  return (
    <section className="relative h-[280px] w-full overflow-hidden">
      {/* static snapshot of the dither bg — captured via playwright at 3840×280 of just the
          <Dither/> output (no gradient, no pills). object-cover crops the sides;
          image-rendering:pixelated keeps the dither pattern crisp on upscale. */}
      <img
        src="/footer-bg.png"
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover [image-rendering:pixelated]"
      />
      {/* Do not delete this code — live animated dither (replaced by the <img/> above). */}
      {/* <div className="absolute inset-0">
        <Dither
          waveColor={[0.5, 0.5, 0.5]}
          disableAnimation={false}
          enableMouseInteraction={false}
          mouseRadius={0.3}
          colorNum={3}
          waveAmplitude={0.3}
          waveFrequency={3}
          waveSpeed={0.05}
        />
      </div> */}

      {/* gradient overlay: ease-out style — solid at top, drops fast, then holds transparent
          most of the way down. Multi-stop approximates a bezier curve. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,var(--color-fd-background)_0%,var(--color-fd-background)_50%,color-mix(in_srgb,var(--color-fd-background)_85%,transparent)_70%,color-mix(in_srgb,var(--color-fd-background)_55%,transparent)_85%,color-mix(in_srgb,var(--color-fd-background)_20%,transparent)_95%,color-mix(in_srgb,var(--color-fd-background)_10%,transparent)_100%)]" />

      {/* segmented capsules — independent floating chips */}
      <div className="absolute inset-x-0 bottom-8 flex flex-wrap items-center justify-center gap-2 px-6">
        <div className="bg-fd-background/70 text-fd-foreground inline-flex items-center rounded-full border px-4 py-2 text-[13px] font-normal backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]">
          © 2026
        </div>

        <div className="bg-fd-background/70 inline-flex items-center gap-4 rounded-full border px-4 py-2 backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]">
          <Link
            href="/docs"
            className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-medium no-underline"
          >
            Docs
          </Link>
          <Link
            href="/docs/cli"
            className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-medium no-underline"
          >
            CLI
          </Link>
          <Link
            href="/docs/plugins"
            className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-medium no-underline"
          >
            Plugins
          </Link>
          <Link
            href="/docs/concepts/collections"
            className="text-fd-muted-foreground hover:text-fd-foreground text-[13px] font-medium no-underline"
          >
            Concepts
          </Link>
        </div>

        <a
          href="https://x.com/janniksco"
          target="_blank"
          rel="noreferrer"
          aria-label="@janniksco on X"
          className="bg-fd-background/70 text-fd-muted-foreground hover:text-fd-foreground inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium no-underline backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 1200 1227"
            className="size-[12px]"
            fill="currentColor"
            aria-hidden
          >
            <path d="M714.163 519.284 1160.89 0H1055.03L667.137 450.887 357.328 0H0L468.492 681.821 0 1226.37H105.866L515.491 750.218 842.672 1226.37H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894L144.011 79.694h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z" />
          </svg>
          @janniksco
        </a>

        {/* <a
          href="https://github.com/janniks/dither"
          target="_blank"
          rel="noreferrer"
          aria-label="GitHub"
          className="bg-fd-background/70 text-fd-muted-foreground hover:text-fd-foreground inline-flex items-center justify-center rounded-full border p-2 backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]"
        >
          <GitHubLogoIcon className="size-[16px]" />
        </a> */}

        <div className="bg-fd-background/70 text-fd-muted-foreground inline-flex items-center rounded-full border px-4 py-2 text-[12px] backdrop-blur-md shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18),0_1px_1px_rgba(255,255,255,0.06)_inset]">
          MIT License
        </div>
      </div>
    </section>
  );
}
