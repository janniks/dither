import { CodeFile } from "@/lib/terminal";
import { ShowMore } from "./show-more";

// Tiny inline syntax styling — no external highlighter, just a few colored
// spans for the keywords/strings/comments that carry the most signal.
const K = "text-[#B093D8]";
const S = "text-[#99D892]";
const F = "text-[#4AB5EC]";

export function PluginUsp() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Plugins are simple TypeScript. Sandboxed.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          The runtime denies anything not granted —{" "}
          <a
            href="https://docs.deno.com/runtime/fundamentals/security/"
            target="_blank"
            rel="noreferrer"
            className="text-fd-foreground underline decoration-fd-muted-foreground/40 underline-offset-2 hover:decoration-fd-foreground"
          >
            Deno sandboxes
          </a>{" "}
          each plugin process. Each plugin declares the URL access list, env,
          and file system scopes it needs; you approve once and the daemon
          enforces it on every run.
        </p>
      </div>

      <div className="mx-auto w-full max-w-[640px]">
        <CodeFile filename="plugins/bookmarks/plugin.ts">
          <ShowMore collapsedHeight={180}>
            <pre className="overflow-auto text-[12px] leading-[20px]">
              <code>
                <span className={K}>import</span>
                {" { readInput, writeEntry } "}
                <span className={K}>from</span>{" "}
                <span className={S}>&quot;@dither/plugin&quot;</span>
                {";\n\n"}
                <span className={K}>const</span>
                {" { env } = "}
                <span className={K}>await</span>{" "}
                <span className={F}>readInput</span>
                {"();\n"}
                <span className={K}>const</span>
                {" res = "}
                <span className={K}>await</span>{" "}
                <span className={F}>fetch</span>
                {"(\n  "}
                <span className={S}>
                  &quot;https://api.raindrop.io/rest/v1/raindrops/0&quot;
                </span>
                {",\n  { headers: { Authorization: "}
                <span className={S}>{"`Bearer ${env.RAINDROP_TOKEN}`"}</span>
                {" } },\n);\n"}
                <span className={K}>const</span>
                {" { items } = "}
                <span className={K}>await</span>
                {" res."}
                <span className={F}>json</span>
                {"();\n\n"}
                <span className={K}>for</span>
                {" ("}
                <span className={K}>const</span>
                {" b "}
                <span className={K}>of</span>
                {" items) {\n  "}
                <span className={K}>await</span>{" "}
                <span className={F}>writeEntry</span>
                {"({\n    collection: "}
                <span className={S}>&quot;bookmarks&quot;</span>
                {",\n    body: "}
                <span className={S}>
                  {"`# ${b.title}\\n\\n${b.excerpt}\\n\\n${b.link}`"}
                </span>
                {",\n    frontmatter: {\n      id: "}
                <span className={F}>String</span>
                {
                  "(b._id),\n      url: b.link,\n      title: b.title,\n      tags: b.tags,\n    },\n  });\n}\n"
                }
              </code>
            </pre>
          </ShowMore>
        </CodeFile>
      </div>
    </section>
  );
}
