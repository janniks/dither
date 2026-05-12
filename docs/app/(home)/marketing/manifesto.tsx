// Manifesto text is copied verbatim from
// ../mmry-homepage-new/app/page.tsx ~lines 600-675 (per spec).
// User will edit "mmry" → "dither" references later.
export function Manifesto() {
  return (
    <section className="flex flex-col items-center gap-6">
      <p className="text-fd-muted-foreground text-[12px] font-semibold tracking-[0.12em] uppercase">
        Manifesto
      </p>
      <article
        className="border bg-fd-card max-w-[720px] rounded-[20px] p-6 sm:p-8 md:p-12"
        style={{ fontFamily: "var(--font-dm-serif), serif" }}
      >
        <div className="text-fd-foreground space-y-3 text-[15px] leading-[24px] sm:space-y-4 sm:text-[16px] sm:leading-[26px] md:text-[18px] md:leading-[30px]">
          <p>Something happened to our digital memories.</p>
          <p>
            They used to belong to us. Photos on hard drives. Emails in
            folders. Bookmarks in browsers. You knew where things were because
            you put them there.
          </p>
          <p>
            Today,{" "}
            <Mark>our memories are scattered</Mark> across a thousand services.
            Your thoughts live in Notion&apos;s cloud. Your conversations in
            Slack&apos;s servers. Your inspirations on Twitter&apos;s
            timeline. Your discoveries buried in Reddit&apos;s endless scroll.
            Each platform holds a piece of your digital self hostage, locked
            behind their walls, searchable only by their rules, accessible
            only at their pleasure.
          </p>
          <p>
            You&apos;ve become a digital tenant, paying rent to access your
            own memories in houses you&apos;ll never own.
          </p>
          <p>
            We believe in a simple truth:{" "}
            <Mark>Your memories belong to you.</Mark>
          </p>
          <p>
            mmry isn&apos;t another cloud service asking for your trust.
            It&apos;s a tool that works for you, not the other way around.
            Connect your services once. Search everything instantly. Keep
            control always.
          </p>
          <p>
            No algorithms deciding what you should remember. No AI training on
            your private thoughts. No venture capitalists monetizing your
            digital soul. Just you, your data, and instant recall when you
            need it.
          </p>
          <p>
            The internet promised to augment human memory. Instead, it
            fragmented it. We&apos;re here to put the pieces back together —
            in your hands, under your control.
          </p>
          <p>
            Your things. Your search. <Mark>Your mmry.</Mark>
          </p>
        </div>
      </article>
    </section>
  );
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <mark className="bg-yellow-200/30 text-fd-foreground rounded-md px-1.5 py-0.5 dark:bg-yellow-300/20">
      {children}
    </mark>
  );
}
