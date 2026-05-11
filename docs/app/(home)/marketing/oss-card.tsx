import { ArrowRight } from "lucide-react";

const REPO_URL = "https://github.com/janniks/dither";

export function OssCard() {
  return (
    <section className="border bg-fd-card flex flex-wrap items-center justify-between gap-4 rounded-[20px] p-6">
      <p className="text-fd-foreground max-w-[720px] text-[15px] leading-[26px]">
        Open source. Read the source. Write a plugin in fifty lines. Open
        issues, ship PRs.
      </p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="text-fd-primary hover:text-fd-foreground inline-flex items-center gap-2 text-sm font-semibold transition-colors"
      >
        github.com/janniks/dither
        <ArrowRight size={16} />
      </a>
    </section>
  );
}
