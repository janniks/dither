// Tiny inline syntax styling — no external highlighter, just a few colored
// spans for the keywords/strings/comments that carry the most signal.
const K = "text-purple-400";
const S = "text-green-400";
const C = "text-fd-muted-foreground italic";
const F = "text-blue-400";

export function PluginUsp() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Plugins are Deno scripts. Sandboxed by default.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          The runtime denies anything not granted. Each plugin declares the
          net, env, and fs scopes it needs; you approve once and the daemon
          enforces it on every run.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CodeCard filename="plugins/bookmarks/plugin.ts">
          <pre className="overflow-auto text-[12px] leading-[20px]">
            <code>
              <span className={K}>import</span>
              {" { defineEntry } "}
              <span className={K}>from</span>
              {" "}
              <span className={S}>&quot;@dither/sdk&quot;</span>
              {";\n\n"}
              <span className={K}>export default</span>
              {" "}
              <span className={F}>defineEntry</span>
              {"("}
              <span className={K}>async</span>
              {" (ctx) => {\n  "}
              <span className={K}>const</span>
              {" token = Deno.env."}
              <span className={F}>get</span>
              {"("}
              <span className={S}>&quot;RAINDROP_TOKEN&quot;</span>
              {");\n  "}
              <span className={K}>const</span>
              {" res = "}
              <span className={K}>await</span>
              {" "}
              <span className={F}>fetch</span>
              {"(\n    "}
              <span className={S}>
                &quot;https://api.raindrop.io/rest/v1/raindrops/0&quot;
              </span>
              {",\n    { headers: { Authorization: "}
              <span className={S}>
                {"`Bearer ${token}`"}
              </span>
              {" } }\n  );\n  "}
              <span className={K}>const</span>
              {" { items } = "}
              <span className={K}>await</span>
              {" res."}
              <span className={F}>json</span>
              {"();\n\n  "}
              <span className={K}>for</span>
              {" ("}
              <span className={K}>const</span>
              {" r "}
              <span className={K}>of</span>
              {" items) {\n    "}
              <span className={K}>await</span>
              {" ctx."}
              <span className={F}>put</span>
              {"({\n      id: "}
              <span className={S}>
                {"`raindrop/${r._id}`"}
              </span>
              {",\n      title: r.title,\n      body: r.excerpt,\n      url: r.link,\n      tags: r.tags,\n    });\n  }\n});\n"}
            </code>
          </pre>
        </CodeCard>

        <CodeCard filename=".dither/grants.toml">
          <pre className="overflow-auto text-[12px] leading-[20px]">
            <code>
              <span className={C}># declared once · enforced every run</span>
              {"\n[plugins.bookmarks]\n"}
              <span className={F}>net</span>
              {" = ["}
              <span className={S}>&quot;api.raindrop.io&quot;</span>
              {"]\n"}
              <span className={F}>env</span>
              {" = ["}
              <span className={S}>&quot;RAINDROP_TOKEN&quot;</span>
              {"]\n"}
              <span className={F}>fs</span>
              {"  = []  "}
              <span className={C}># no filesystem access</span>
              {"\n"}
            </code>
          </pre>
        </CodeCard>
      </div>
    </section>
  );
}

function CodeCard({
  filename,
  children,
}: {
  filename: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border bg-fd-card flex flex-col overflow-hidden rounded-[16px]">
      <div className="border-b bg-fd-muted/40 text-fd-muted-foreground flex items-center gap-2 px-4 py-2 text-[12px] font-mono">
        <span className="bg-red-500/70 h-2 w-2 rounded-full" />
        <span className="bg-yellow-500/70 h-2 w-2 rounded-full" />
        <span className="bg-green-500/70 h-2 w-2 rounded-full" />
        <span className="ml-2">{filename}</span>
      </div>
      <div className="p-5 font-mono">{children}</div>
    </div>
  );
}
