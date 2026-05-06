# `dither init` command

Today: model weights are downloaded lazily on first `search` (and probably first index too). Surprising — first call hangs while a download happens with no clear up-front signal.

Want: an explicit `dither init` that:

- creates `DITHER_HOME` dirs (`entries/`, `plugins/`, etc.)
- pre-downloads embedding/rerank model weights so the first real command is fast
- maybe verifies the qmd index db is initialized

Open questions:

- which models exactly, and where qmd caches them
- should `init` be idempotent / safe to re-run (probably yes)
- progress UX during download
- offline behavior — fail loudly vs. fall back to lex-only?
