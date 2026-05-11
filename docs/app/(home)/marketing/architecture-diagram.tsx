export function ArchitectureDiagram() {
  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-[720px]">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          The whole stack on one page.
        </h2>
        <p className="text-fd-muted-foreground mt-3 text-[15px] leading-[24px]">
          A wrapper around qmd. The CLI, the daemon, the MCP server, and the
          Deno plugin runtime all talk to the same index. The index lives next
          to your markdown.
        </p>
      </div>
      <div className="border bg-fd-card overflow-hidden rounded-[20px] p-6 md:p-10">
        {/* SVG on md+, ASCII fallback on smaller viewports */}
        <div className="hidden md:block">
          <ArchSvg />
        </div>
        <div className="md:hidden">
          <ArchAscii />
        </div>
      </div>
    </section>
  );
}

function ArchSvg() {
  return (
    <svg
      viewBox="0 0 600 460"
      xmlns="http://www.w3.org/2000/svg"
      className="text-fd-border w-full"
      role="img"
      aria-label="dither architecture: markdown on disk, qmd index, dither core, and the CLI / MCP / daemon / watcher / plugins surfaces."
    >
      {/* Row 1: markdown on disk */}
      <Box x={150} y={20} w={300} h={56} title="markdown on disk" subtitle="~/notes/**/*.md" />

      {/* arrow down */}
      <Arrow x1={300} y1={76} x2={300} y2={120} />

      {/* Row 2: qmd index */}
      <Box
        x={150}
        y={120}
        w={300}
        h={56}
        title="qmd index"
        subtitle="~/notes/.dither/index.qmd"
        accent
      />

      {/* arrow down */}
      <Arrow x1={300} y1={176} x2={300} y2={220} />

      {/* Row 3: dither core */}
      <Box x={150} y={220} w={300} h={56} title="dither core" subtitle="rust" />

      {/* fan-out lines from core bottom */}
      <Arrow x1={210} y1={276} x2={70} y2={340} />
      <Arrow x1={250} y1={276} x2={180} y2={340} />
      <Arrow x1={300} y1={276} x2={300} y2={340} />
      <Arrow x1={350} y1={276} x2={420} y2={340} />
      <Arrow x1={390} y1={276} x2={530} y2={340} />

      {/* Row 4: leaf surfaces */}
      <Leaf x={20} y={340} title="CLI" subtitle="all the verbs" />
      <Leaf x={130} y={340} title="MCP" subtitle="agent tools" />
      <Leaf x={250} y={340} title="daemon" subtitle="cron loop" />
      <Leaf x={370} y={340} title="watcher" subtitle="fs events" />
      <Leaf x={480} y={340} title="plugins" subtitle="Deno sandbox" />
    </svg>
  );
}

function Box({
  x,
  y,
  w,
  h,
  title,
  subtitle,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        ry={12}
        fill="transparent"
        stroke="currentColor"
        strokeWidth={accent ? 2 : 1.25}
      />
      <text
        x={x + w / 2}
        y={y + 22}
        textAnchor="middle"
        className="fill-fd-foreground"
        fontSize={15}
        fontWeight={600}
      >
        {title}
      </text>
      <text
        x={x + w / 2}
        y={y + 42}
        textAnchor="middle"
        className="fill-fd-muted-foreground"
        fontSize={12}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {subtitle}
      </text>
    </g>
  );
}

function Leaf({
  x,
  y,
  title,
  subtitle,
}: {
  x: number;
  y: number;
  title: string;
  subtitle: string;
}) {
  const w = 100;
  const h = 60;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        ry={10}
        fill="transparent"
        stroke="currentColor"
        strokeWidth={1.25}
      />
      <text
        x={x + w / 2}
        y={y + 22}
        textAnchor="middle"
        className="fill-fd-foreground"
        fontSize={13}
        fontWeight={600}
      >
        {title}
      </text>
      <text
        x={x + w / 2}
        y={y + 42}
        textAnchor="middle"
        className="fill-fd-muted-foreground"
        fontSize={11}
      >
        {subtitle}
      </text>
    </g>
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
    />
  );
}

function ArchAscii() {
  return (
    <pre className="text-fd-foreground overflow-auto font-mono text-[11px] leading-[16px]">
{`     ┌────────────────────────┐
     │  markdown on disk      │
     │  ~/notes/**/*.md       │
     └───────────┬────────────┘
                 │
     ┌───────────▼────────────┐
     │  qmd index             │
     │  .dither/index.qmd     │
     └───────────┬────────────┘
                 │
     ┌───────────▼────────────┐
     │  dither core           │
     └─┬─────┬───┬────┬─────┬─┘
       │     │   │    │     │
     ┌─▼─┐ ┌─▼┐ ┌▼──┐┌▼──┐ ┌▼──────┐
     │CLI│ │MCP│ │dmn││wch│ │plugin │
     │   │ │   │ │   ││   │ │ Deno  │
     └───┘ └───┘ └───┘└───┘ └───────┘`}
    </pre>
  );
}
