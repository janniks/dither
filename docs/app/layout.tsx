import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DM_Serif_Text, Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

const dmSerifText = DM_Serif_Text({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-dm-serif",
  display: "swap",
});

// Tailwind v4 has no `xs:` prefix — the default (no prefix) IS the smallest
// breakpoint. This badge labels it "xs" anyway since that's how we refer to
// it throughout the codebase.
function BreakpointBadge() {
  return (
    <div
      aria-hidden
      className="text-white/55 bg-black/55 pointer-events-none fixed right-0.5 top-0.5 z-[9999] rounded px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-tight"
    >
      <span className="sm:hidden">xs</span>
      <span className="hidden sm:inline md:hidden">sm</span>
      <span className="hidden md:inline lg:hidden">md</span>
      <span className="hidden lg:inline xl:hidden">lg</span>
      <span className="hidden xl:inline 2xl:hidden">xl</span>
      <span className="hidden 2xl:inline">2xl</span>
    </div>
  );
}

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.className} ${dmSerifText.variable} scroll-smooth`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ defaultTheme: "dark" }}>{children}</RootProvider>
        {process.env.NODE_ENV !== "production" && <BreakpointBadge />}
      </body>
    </html>
  );
}
