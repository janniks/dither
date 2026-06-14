import Link from "next/link";
import { ArrowRight, Quote } from "lucide-react";
import { GitHubLogoIcon } from "@radix-ui/react-icons";
import { RotatingHeadline } from "./rotating-headline";
import { FooterSection } from "./footer-section";
import { FeatureGrid } from "./marketing/feature-grid";
import { NoBsStrip } from "./marketing/no-bs-strip";
import { PluginUsp } from "./marketing/plugin-usp";
import { WaveRow } from "./marketing/wave-row";
import { ScheduleWatchDemo } from "./marketing/schedule-watch-demo";
import { TerminalTabs } from "./marketing/terminal-tabs";
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
        <section className="flex max-w-[760px] flex-col items-start">
          <a
            href="#manifesto"
            className="border bg-fd-card text-fd-muted-foreground hover:text-fd-foreground hover:border-fd-primary/40 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm leading-5 no-underline transition-colors"
          >
            <Quote size={14} className="text-[#99D892]" />
            Read Manifesto
          </a>
          <div className="mt-6 max-w-[820px]">
            <RotatingHeadline />
          </div>
          <p className="text-fd-muted-foreground mt-6 max-w-[660px] text-lg leading-[30px]">
            Open source, local-first, and sandboxed. Drop markdown into
            collections, run plugins to pull data in, and search across
            everything from one CLI.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="bg-fd-primary text-fd-primary-foreground inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-3 text-sm font-semibold"
            >
              Get started
              <ArrowRight size={16} />
            </Link>
            <a
              href="https://github.com/janniks/dither"
              target="_blank"
              rel="noreferrer"
              className="border bg-fd-card hover:bg-fd-accent inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-3 text-sm font-semibold no-underline transition-colors"
            >
              <GitHubLogoIcon className="size-4" />
              GitHub
            </a>
          </div>
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

        <TerminalTabs />
        <JustMarkdown />
        <FeatureGrid />
        <NoBsStrip />
        <PluginUsp />
        {/* <AgentMarquee /> */}
        <WaveRow />
        <ScheduleWatchDemo />
        {/* <ArchitectureDiagram /> */}
        {/* <TerminalMcp /> */}
        <hr className="border-fd-border mx-auto w-full max-w-[760px] border-t" />
        <SphereRow />
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
