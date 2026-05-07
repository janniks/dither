// The managed-deno bootstrap (`deno-bootstrap.ts`) downloads a real Deno
// release on first plugin install/run. Tests should never pull a 30 MB
// binary from the network; the opt-out short-circuits to `which deno`.
process.env.DITHER_USE_SYSTEM_DENO = "1";
