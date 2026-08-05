import { HeroCtas, ManifestoLink } from "./hero-ctas";
import { RotatingHeadline } from "./rotating-headline";
import { HandSearch } from "./hand-search";
import { FooterSection } from "./footer-section";
import { FeatureGrid } from "./marketing/feature-grid";
import { NoBsStrip } from "./marketing/no-bs-strip";
import { PluginUsp } from "./marketing/plugin-usp";
import { WaveRow } from "./marketing/wave-row";
import { ScheduleWatchDemo } from "./marketing/schedule-watch-demo";
import { TerminalTabs } from "./marketing/terminal-tabs";
import { ToolMarquee } from "./marketing/tool-marquee";
import { JustMarkdown } from "./marketing/just-markdown";
import { SphereRow } from "./marketing/sphere-row";
import { Manifesto } from "./marketing/manifesto";
import { Faq } from "./marketing/faq";
import { OssCard } from "./marketing/oss-card";
import { DitheredCta } from "./marketing/dithered-cta";

export default function HomePage() {
  return (
    <>
      <div className="flex w-full justify-center px-[20px] pt-22 pb-18 sm:px-8 md:px-12 lg:px-16">
        <div className="flex w-full max-w-[1080px] flex-col gap-14">
          <section className="mx-auto flex w-full max-w-[760px] flex-col items-start">
            <ManifestoLink />
            {/* translateZ(0): headline letters jiggle during the chip's layout
              animation unless the whole headline subtree sits on its own GPU
              layer. The layer must be forced from OUTSIDE the h1 — a transform
              inside it (on TextRotate or its siblings) conflicts with motion's
              layout springs and makes it worse. When the ToolMarquee still
              lived in the hero its animation forced this compositing for free;
              moving it out brought the jiggle back. */}
            <div
              className="relative mt-6 max-w-[820px]"
              style={{ transform: "translateZ(0)" }}
            >
              {/* Hand-drawn annotation — deliberately OUTSIDE the h1: anything
                rendered inside the headline's subtree (even inert absolute
                overlays) disturbs its motion layout springs → letter jiggle. */}
              <HandSearch className="pointer-events-none absolute -top-9 left-[7.5ch] hidden md:block" />
              <RotatingHeadline />
            </div>
            <p className="text-fd-muted-foreground mt-6 max-w-[660px] text-lg leading-[30px]">
              Open source, local-first, and sandboxed. Run plugins to index your
              data, then search across everything from one CLI.
            </p>
            {/* TEMPORARY: CTA row is variant-driven while we pick a direction. */}
            <HeroCtas />
          </section>

          {/* Hidden for now — kept for reference / future re-enable.
        <section className="flex flex-wrap gap-4">
          {links.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="group border bg-fd-card hover:border-fd-primary/50 hover:bg-fd-accent/50 flex min-w-[260px] flex-1 flex-col rounded-[20px] p-6 no-underline transition-colors duration-150"
              >
                <div className="bg-fd-muted text-fd-muted-foreground group-hover:text-fd-primary flex h-11 w-11 items-center justify-center rounded-[14px]">
                  <Icon size={22} />
                </div>
                <h2 className="mt-6 flex items-center gap-2 text-xl font-semibold">
                  {item.title}
                  <ArrowRight size={16} />
                </h2>
                <p className="text-fd-muted-foreground mt-2.5 text-sm leading-6">
                  {item.description}
                </p>
              </Link>
            );
          })}
        </section>
        */}

          <div className="mx-auto -mt-6 w-full max-w-[880px]">
            <ToolMarquee />
          </div>
          <TerminalTabs />
          <FeatureGrid />
          <JustMarkdown />
          <NoBsStrip />
          {/* <AgentMarquee /> */}
          <WaveRow />
          <SphereRow />
          <hr className="border-fd-border mx-auto w-full max-w-[760px] border-t" />
          <PluginUsp />
          {/* <ArchitectureDiagram /> */}
          {/* <TerminalMcp /> */}
          <hr className="border-fd-border mx-auto w-full max-w-[760px] border-t" />
          <ScheduleWatchDemo />
          <Manifesto />
          <Faq />

          <section className="flex justify-center py-2">
            <DitheredCta href="/docs">Try it out now</DitheredCta>
          </section>

          <OssCard />
        </div>
      </div>
      <FooterSection />
    </>
  );
}
