// "It's just markdown." — one card showing the actual on-disk layout of a
// dither library. Mixes human-authored notes, plugin-written entries, and
// an in-place Obsidian vault to make the point: dither is a coordinator
// over plain files, never a wrapper around its own format.

export function JustMarkdown() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[760px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          It&apos;s just markdown.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          Plugins write markdown into your library. Search indexes those
          files in place. There&apos;s no database, no second copy, no
          proprietary format — your data is plain files you can edit, grep,
          or move without dither. Point a collection at your existing
          Obsidian vault (or any folder of notes) and it shows up alongside
          plugin-written entries, indexed where it lives.
        </p>
      </div>

      <div className="border-fd-border overflow-hidden rounded-[14px] border">
        <div className="border-fd-border bg-fd-muted/30 text-fd-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[12px]">
          <span className="h-2 w-2 rounded-full bg-[#E46A6A]"></span>
          <span className="h-2 w-2 rounded-full bg-[#E2C04C]"></span>
          <span className="h-2 w-2 rounded-full bg-[#5DCE78]"></span>
          <span className="ml-2 truncate">$ tree ~/.dither/library</span>
        </div>
        <pre className="text-fd-foreground p-5 font-mono text-[12.5px] leading-[20px] whitespace-pre overflow-x-auto">
{`~/.dither/library
├── notes/                       `}<span className="text-fd-muted-foreground">{`# you write these in your editor`}</span>{`
│   ├── standup-tue.md
│   ├── ranking-signals.md
│   └── ideas/
│       └── grant-defaults.md
├── raindrop/                    `}<span className="text-fd-muted-foreground">{`# written by the raindrop plugin`}</span>{`
│   ├── grug-brained-developer.md
│   └── deno-runtime-deep-dive.md
├── pocket/                      `}<span className="text-fd-muted-foreground">{`# written by the pocket plugin`}</span>{`
│   └── how-to-backdoor-friends.md
├── feeds/hn/                    `}<span className="text-fd-muted-foreground">{`# written by the rss plugin`}</span>{`
│   └── 2026-04-22.md
└── vault → ~/Documents/Obsidian `}<span className="text-fd-muted-foreground">{`# your obsidian vault, indexed in place`}</span>{`
    ├── Daily/2026-05-13.md
    └── Projects/dither.md
`}
        </pre>
      </div>
    </section>
  );
}
