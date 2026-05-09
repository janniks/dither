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

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.className} ${dmSerifText.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ defaultTheme: "dark" }}>{children}</RootProvider>
      </body>
    </html>
  );
}
