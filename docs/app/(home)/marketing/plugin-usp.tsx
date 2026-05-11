const pluginSrc = `// plugins/bookmarks/plugin.ts
import { defineEntry } from "@dither/sdk";

export default defineEntry(async (ctx) => {
  const token = Deno.env.get("RAINDROP_TOKEN");
  const res = await fetch("https://api.raindrop.io/rest/v1/raindrops/0", {
    headers: { Authorization: \`Bearer \${token}\` },
  });
  const { items } = await res.json();

  for (const r of items) {
    await ctx.put({
      id: \`raindrop/\${r._id}\`,
      title: r.title,
      body: r.excerpt,
      url: r.link,
      tags: r.tags,
      createdAt: r.created,
    });
  }
});
`;

const grantsSrc = `# .dither/grants.toml
[plugins.bookmarks]
net = ["api.raindrop.io"]
env = ["RAINDROP_TOKEN"]
fs  = []  # no filesystem access
`;

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
        <pre className="border bg-fd-card text-fd-foreground overflow-auto rounded-[16px] p-5 text-[12px] leading-[20px]">
          <code>{pluginSrc}</code>
        </pre>
        <pre className="border bg-fd-card text-fd-foreground overflow-auto rounded-[16px] p-5 text-[12px] leading-[20px]">
          <code>{grantsSrc}</code>
        </pre>
      </div>
    </section>
  );
}
