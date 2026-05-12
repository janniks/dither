import Link from "next/link";
import { ArrowRight, Boxes, Plug, Quote, Terminal } from "lucide-react";
import { RotatingHeadline } from "./rotating-headline";
import { FooterSection } from "./footer-section";
import { FeatureGrid } from "./marketing/feature-grid";
import { NoBsStrip } from "./marketing/no-bs-strip";
import { PluginUsp } from "./marketing/plugin-usp";
import { WaveRow } from "./marketing/wave-row";
import { ScheduleWatchDemo } from "./marketing/schedule-watch-demo";
import { ArchitectureDiagram } from "./marketing/architecture-diagram";
import { TerminalMcp } from "./marketing/terminal-mcp";
import { SphereRow } from "./marketing/sphere-row";
import { Manifesto } from "./marketing/manifesto";
import { Faq } from "./marketing/faq";
import { OssCard } from "./marketing/oss-card";
import { DitheredCta } from "./marketing/dithered-cta";
import { AgentMarquee } from "./marketing/agent-marquee";

const links = [
  {
    href: "/docs/cli",
    title: "CLI reference",
    description:
      "Every command, every flag, with worked examples for ingest, index, and search.",
    icon: Terminal,
  },
  {
    href: "/docs/plugins",
    title: "Plugin authoring",
    description:
      "Write a Deno plugin that pulls data from the world into a collection.",
    icon: Plug,
  },
  {
    href: "/docs/concepts",
    title: "Concepts",
    description:
      "Entries, collections, grants, the run-dir model — the mental picture behind the CLI.",
    icon: Boxes,
  },
];

export default function HomePage() {
  return (
    <>
      <div className="flex w-full justify-center px-6 pt-22 pb-18">
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
            Local-first, plugin-driven, sandboxed. Drop markdown into
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
            <Link
              href="/docs/cli"
              className="border bg-fd-card hover:bg-fd-accent inline-flex items-center justify-center rounded-[10px] px-4 py-3 text-sm font-semibold"
            >
              CLI Reference
            </Link>
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
