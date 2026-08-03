import { ArrowRight } from "lucide-react";
import { GitHubLogoIcon } from "@radix-ui/react-icons";

const REPO_URL = "https://github.com/janniks/dither";

export function OssCard() {
  return (
    <section className="mx-auto w-full max-w-[880px] border bg-fd-card flex flex-wrap items-center justify-between gap-4 rounded-[20px] p-6">
      <p className="text-fd-foreground max-w-[720px] text-[15px] leading-[26px]">
        Read the source code. Open issues, ship PRs.
      </p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="text-fd-foreground inline-flex items-center gap-2 text-sm font-semibold underline decoration-fd-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-fd-foreground"
      >
        <GitHubLogoIcon className="size-4" />
        github.com/janniks/dither
        <ArrowRight size={16} />
      </a>
    </section>
  );
}
