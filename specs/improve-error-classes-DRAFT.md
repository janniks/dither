# Improve Error Classes

> Exploration. No code changes. Survey + before/after sketches + tradeoffs.

## Where we are today

Survey (across `packages/cli/src/**`):

- **Custom Error subclasses: zero.** Everything throws vanilla `Error`.
- **Error-code checks (idiomatic, already in use):** `(err as NodeJS.ErrnoException).code === "ENOENT" | "EEXIST" | "ESRCH" | "EPERM"` — `locks.ts:34,37,65,72,87,105`, `daemon-control.ts:22,23,36,108,129`, `daemon.ts:132`, `journal.ts:132,184`.
- **One ad-hoc attribute case:** `plugin-run.ts:357–361` attaches `exitCode` and `expected` to a plain `Error` via cast; `commands/plugin.ts:231–232` reads them back.
- **One regex-based stderr classification:** `/PermissionDenied|EPERM/i` at `plugin-run.ts:330`, paired with the path-extractor in `tcc-hint.ts:50–56`.

So the thesis ("we have too many custom error classes") doesn't quite map: we have *none*. The real questions are (a) should we *introduce* any, (b) is the existing ad-hoc-attribute pattern good enough as-is, and (c) where is centralization actually worth it.

## Thesis (refined)

Keep the "no custom Error subclasses" property. Lean harder into what's already there:

1. **Use error codes.** When throwing from our own code, attach a string `code` field, not a class.
2. **Centralize identifying strings.** A single `errors.ts` constants module holds error codes and any substrings/regexes used for classification. No ad-hoc `'EPERM'` / `/PermissionDenied/` literals scattered at catch sites.
3. **Detect by `code` first, substring as fallback.** Substrings only when the error originates outside our control (subprocess stderr, third-party libs).
4. **No wrapper classes.** A class earns its place only if `instanceof` is the only ergonomic discriminator — and we don't have that case today.

The output is closer to a *style rule + small constants file* than a refactor.

## Concrete sketches

### Example 1 — plugin-run exit error (the one ad-hoc case)

**Today** (`packages/cli/src/plugin-run.ts:354–362`):

```ts
const message = sawProtectedEpermPath
  ? formatFdaError(sawProtectedEpermPath)
  : `plugin '${opts.name}' exited with code ${code}`;
const err = new Error(message);
(err as Error & { exitCode?: number; expected?: boolean }).exitCode = code ?? -1;
if (sawProtectedEpermPath) {
  (err as Error & { expected?: boolean }).expected = true;
}
rej(err);
```

…and at the catch site (`commands/plugin.ts:229–239`):

```ts
} catch (err) {
  if (tty) process.stderr.write("\r\x1b[K");
  const e = err as Error & { expected?: boolean; exitCode?: number };
  if (e?.expected === true) {
    process.stderr.write(`${e.message}\n`);
    if (!args["no-auto-open"] && process.stdin.isTTY && process.stderr.isTTY) {
      await maybeOpenFdaSettings();
    }
    process.exit(e.exitCode ?? 1);
  }
  throw err;
}
```

**Proposed.** Replace `expected: boolean` with a typed `code` string from a shared constants module. Wrap the cast once in a helper so the call sites lose their inline `as Error & {...}`.

```ts
// packages/cli/src/errors.ts (new)
export const ERR = {
  PluginExit: "PLUGIN_EXIT",        // generic non-zero exit
  FdaRequired: "FDA_REQUIRED",      // macOS protected-path EPERM
} as const;

export type DitherErrCode = (typeof ERR)[keyof typeof ERR];

export interface DitherError extends Error {
  code: DitherErrCode;
  exitCode?: number;
}

export function fail(code: DitherErrCode, message: string, extra?: { exitCode?: number }): DitherError {
  const err = new Error(message) as DitherError;
  err.code = code;
  if (extra?.exitCode !== undefined) err.exitCode = extra.exitCode;
  return err;
}

export function hasCode(err: unknown, code: DitherErrCode): err is DitherError {
  return err instanceof Error && (err as DitherError).code === code;
}
```

Throw site:

```ts
rej(fail(
  sawProtectedEpermPath ? ERR.FdaRequired : ERR.PluginExit,
  sawProtectedEpermPath ? formatFdaError(sawProtectedEpermPath) : `plugin '${opts.name}' exited with code ${code}`,
  { exitCode: code ?? -1 },
));
```

Catch site:

```ts
} catch (err) {
  if (tty) process.stderr.write("\r\x1b[K");
  if (hasCode(err, ERR.FdaRequired)) {
    process.stderr.write(`${err.message}\n`);
    if (!args["no-auto-open"] && process.stdin.isTTY && process.stderr.isTTY) {
      await maybeOpenFdaSettings();
    }
    process.exit(err.exitCode ?? 1);
  }
  throw err;
}
```

What changed:
- The discriminator went from a vague `expected: boolean` (true means "FDA, kind of?") to a named code that tells you *why*.
- `as Error & { ... }` casts moved to one place (`hasCode`).
- The catch site reads as English: "if the error has code FDA_REQUIRED…".
- Still no class. Still a plain `Error` with extra fields.

### Example 2 — Node syscall codes (already idiomatic; minor cleanup)

**Today** (`packages/cli/src/locks.ts:33–39`):

```ts
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ESRCH") return false;
  if (code === "EPERM") return true;
  throw err;
}
```

This is fine. It already uses `code`, the strings are Node's, not ours, and the literals are unavoidable. The only cleanup worth considering is a tiny helper to avoid the cast:

```ts
// in errors.ts
export const errno = (err: unknown): string | undefined =>
  err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
```

Catch site becomes:

```ts
} catch (err) {
  if (errno(err) === "ESRCH") return false;
  if (errno(err) === "EPERM") return true;
  throw err;
}
```

Smaller win than Example 1. Borderline worth doing — depends on whether we like `errno(err)` more than the inline cast. **Lean: do it**, because the cast is repeated ~12 times across the repo and the helper is one line.

### Example 3 — stderr classification regex

**Today** (`packages/cli/src/plugin-run.ts:329–334`):

```ts
if (
  isMacOS() &&
  sawProtectedEpermPath === null &&
  /PermissionDenied|EPERM/i.test(line)
) {
  const path = findProtectedPathInError(line);
  if (path) sawProtectedEpermPath = path;
}
```

This is the cleanest case for centralization. The string `/PermissionDenied|EPERM/i` is a *fact about Deno's stderr format* — it's the kind of thing we'll want to find again the day Deno changes its wording.

**Proposed.** Move the regex to `errors.ts` next to the `FdaRequired` code so the two halves of the same concern live together:

```ts
// errors.ts
export const PATTERNS = {
  /** Substring/regex that identifies a Deno permission-denied stderr line. */
  denoPermissionDenied: /PermissionDenied|EPERM/i,
} as const;
```

```ts
if (
  isMacOS() &&
  sawProtectedEpermPath === null &&
  PATTERNS.denoPermissionDenied.test(line)
) { … }
```

Trivial in isolation, but earns its keep as soon as we add a second pattern (e.g. plugin-runtime version mismatch, qmd schema mismatch). One module, one place to look.

## Advantages

- **No class hierarchy to maintain.** Adding a new error condition is "add a string to `ERR`," not "subclass Error, export it, audit `instanceof` sites."
- **Discriminators are named.** `ERR.FdaRequired` is self-documenting in a way `expected: true` is not.
- **Casts shrink to one place.** The `as Error & { ... }` pattern survives in `hasCode` / `errno` and disappears from feature code.
- **Portable.** Codes and substrings are plain strings — they cross IPC boundaries, JSON logs, and the daemon journal without a custom serializer. `instanceof` does not.
- **Plays well with what we already have.** Node's syscall errors already use this exact shape; we'd be aligning, not inventing.

## Disadvantages / risks

- **Stringly-typed.** `err.code === "FDA_REQUIRD"` (typo) compiles. The `hasCode(err, ERR.FdaRequired)` helper mitigates this, but only if every catch site uses it. A discipline issue.
- **No type-narrowing on extra fields.** With a class, `if (err instanceof PluginExitError)` narrows `err.exitCode` to `number`. With our shape, `exitCode` stays `number | undefined`. Manageable — we already live with this — but a real ergonomics tax if a future error grows several payload fields.
- **Substring-based detection is fragile.** Tying behavior to `/PermissionDenied|EPERM/i` means Deno can break us by rewording. We accept this *only* for errors crossing process boundaries; for internal errors, codes are mandatory.
- **`hasCode` only works for our own throws.** `NodeJS.ErrnoException` has its own `.code` namespace ("ENOENT") that we don't own. Two `code` namespaces is fine in practice (they don't collide), but worth calling out.
- **Risk of over-centralizing.** Pulling a string into `errors.ts` because it *might* get reused, when it's used in exactly one place, just adds indirection. Rule of thumb: move it on the second use, or when the string crosses a module boundary.

## Scope if we do it

Small. Concretely:

1. New `packages/cli/src/errors.ts` with `ERR`, `DitherError`, `fail`, `hasCode`, `errno`, `PATTERNS`.
2. `plugin-run.ts` + `commands/plugin.ts`: replace `expected`/`exitCode` ad-hoc cast with `fail(ERR.FdaRequired, ...)` + `hasCode`.
3. `plugin-run.ts:330`: replace inline regex with `PATTERNS.denoPermissionDenied`.
4. (Optional, low value) sweep `(err as NodeJS.ErrnoException).code` → `errno(err)` across `locks.ts`, `daemon-control.ts`, `journal.ts`, `daemon.ts`. Defer if it churns review for marginal gain.

No new tests required — behavior unchanged. Possibly one tiny test for `hasCode` and `errno` since they're new public helpers.

## Open questions

- Do we want `ERR` to be a flat namespace or grouped (`ERR.plugin.exit`)? Flat is simpler; grouping pays off only past ~10 codes. **Lean: flat until it hurts.**
- Do we want the error code in the rendered message (`error [FDA_REQUIRED]: …`)? `formatFdaError` already does this. Decide whether that's a convention or a one-off. **Lean: convention** — makes errors greppable in the journal.
- Should `DitherError` extend Node's `ErrnoException` shape so `errno()` works on our errors too? Probably not — different namespace, different meaning.
