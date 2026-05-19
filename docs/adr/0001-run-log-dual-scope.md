# Run-log keeps two scopes (global + per-run)

When unifying the journal and events-log modules behind one **Run-log** seam, we deliberately kept two on-disk scopes — a single global JSONL at `~/.dither/run-log.jsonl` and a per-**Run** JSONL inside each `~/.dither/history/<runId>/` directory — rather than collapsing everything into the global log and tagging events with `runId`.

The two scopes have different lifetimes: the global log rotates at a size threshold and represents "what the system is currently doing"; per-**Run** logs live exactly as long as the **Run** directory and are deleted with it. Collapsing them would make `dither runs tail <runId>` either expensive (full-log scan) or wrong (after rotation, old run events are gone). Keeping the global log mirrors how Linux logs work: dmesg-style ring at one path, per-session details at another.

The seam is one module with two scopes; the on-disk layout is two paths. The deepening is in the interface, not in the directory tree.
