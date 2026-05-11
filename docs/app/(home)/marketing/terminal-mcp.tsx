"use client";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/lib/terminal";

export function TerminalMcp() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-[650] tracking-[-0.02em]">
          Wired into every agent.
        </h2>
        <p className="text-fd-muted-foreground text-[15px] leading-[24px]">
          One command and your index becomes a tool source for any
          MCP-compatible agent — Claude Code, Cursor, anything that speaks the
          protocol.
        </p>
      </div>
      <div className="flex justify-center md:justify-start">
        <Terminal>
          <TypingAnimation>$ dither mcp serve</TypingAnimation>
          <AnimatedSpan className="text-green-500">
            ✔ MCP server listening on stdio
          </AnimatedSpan>
          <AnimatedSpan className="text-fd-muted-foreground">
            tools: search · show · list · add · tag · grep
          </AnimatedSpan>
          <AnimatedSpan>
            <span className="text-blue-500">
              claude mcp add dither -- dither mcp serve
            </span>
          </AnimatedSpan>
        </Terminal>
      </div>
    </section>
  );
}
