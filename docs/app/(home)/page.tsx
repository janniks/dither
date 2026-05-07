import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Plug,
  Sparkles,
  Terminal,
} from "lucide-react";

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
    <div
      className="w-full"
      style={{
        display: "flex",
        flex: "1 1 auto",
        justifyContent: "center",
        padding: "88px 24px 72px",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          maxWidth: 1080,
          flexDirection: "column",
          gap: 56,
        }}
      >
        <section
          style={{
            display: "flex",
            maxWidth: 760,
            flexDirection: "column",
            alignItems: "flex-start",
          }}
        >
          <div
            className="border bg-fd-card text-fd-muted-foreground"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              borderRadius: 999,
              padding: "6px 12px",
              fontSize: 14,
              lineHeight: "20px",
            }}
          >
            <Sparkles size={16} />
            dither documentation
          </div>
          <h1
            style={{
              marginTop: 24,
              maxWidth: 820,
              fontSize: "clamp(44px, 7vw, 72px)",
              lineHeight: 0.95,
              fontWeight: 650,
              letterSpacing: "-0.05em",
            }}
          >
            A personal index for the agentic era.
          </h1>
          <p
            className="text-fd-muted-foreground"
            style={{
              marginTop: 24,
              maxWidth: 660,
              fontSize: 18,
              lineHeight: "30px",
            }}
          >
            Local-first, plugin-driven, sandboxed. Drop markdown into
            collections, run plugins to pull data in, and search across
            everything from one CLI.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 32,
            }}
          >
            <Link
              href="/docs"
              className="bg-fd-primary text-fd-primary-foreground"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                borderRadius: 10,
                padding: "12px 16px",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Get started
              <ArrowRight size={16} />
            </Link>
            <Link
              href="/docs/cli"
              className="border bg-fd-card hover:bg-fd-accent"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                padding: "12px 16px",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Browse the CLI
            </Link>
          </div>
        </section>

        <section
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          {links.map((item) => {
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className="group border bg-fd-card hover:border-fd-primary/50 hover:bg-fd-accent/50"
                style={{
                  display: "flex",
                  minWidth: 260,
                  flex: "1 1 0",
                  flexDirection: "column",
                  borderRadius: 20,
                  padding: 24,
                  textDecoration: "none",
                  transition: "background-color 160ms, border-color 160ms",
                }}
              >
                <div
                  className="bg-fd-muted text-fd-muted-foreground group-hover:text-fd-primary"
                  style={{
                    display: "flex",
                    width: 44,
                    height: 44,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 14,
                  }}
                >
                  <Icon size={22} />
                </div>
                <h2
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 24,
                    fontSize: 20,
                    fontWeight: 600,
                  }}
                >
                  {item.title}
                  <ArrowRight size={16} />
                </h2>
                <p
                  className="text-fd-muted-foreground"
                  style={{
                    marginTop: 10,
                    fontSize: 14,
                    lineHeight: "24px",
                  }}
                >
                  {item.description}
                </p>
              </Link>
            );
          })}
        </section>

        <section
          className="border bg-fd-card"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            borderRadius: 20,
            padding: 24,
          }}
        >
          <p
            className="text-fd-muted-foreground"
            style={{ maxWidth: 720, fontSize: 15, lineHeight: "26px" }}
          >
            v0 ships today: a CLI, a markdown-on-disk store, a qmd-backed
            hybrid search index, and a Deno-sandboxed plugin runtime. Daemon,
            MCP server, sync, and scheduling come later.
          </p>
          <Link
            href="/docs"
            className="text-fd-primary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Read the overview
            <ArrowRight size={16} />
          </Link>
        </section>
      </div>
    </div>
  );
}
