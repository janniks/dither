"use client";
import Link from "next/link";
import { LargeSearchToggle } from "fumadocs-ui/components/layout/search-toggle";
import { NavLogo } from "@/lib/nav-logo";

export function HomeNav() {
  return (
    <header
      className="border-b bg-fd-background/80"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        width: "100%",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <nav
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "10px 16px",
        }}
      >
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <NavLogo />
        </Link>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <Link
            href="/docs"
            className="text-fd-muted-foreground hover:text-fd-foreground"
            style={{ fontSize: 14, fontWeight: 600, textDecoration: "none" }}
          >
            Docs
          </Link>
          <Link
            href="/logo-lab"
            className="text-fd-muted-foreground hover:text-fd-foreground"
            style={{ fontSize: 14, fontWeight: 600, textDecoration: "none" }}
          >
            Lab
          </Link>
          <a
            href="https://github.com/janniks/openindex"
            target="_blank"
            rel="noreferrer"
            className="text-fd-muted-foreground hover:text-fd-foreground"
            style={{ fontSize: 14, fontWeight: 600, textDecoration: "none" }}
          >
            GitHub
          </a>
          <div style={{ width: 240 }}>
            <LargeSearchToggle style={{ width: "100%" }} />
          </div>
        </div>
      </nav>
    </header>
  );
}
