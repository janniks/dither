# dither logo ideation

Prototype route: `docs/app/(home)/logo-lab/` (temp, contained).

## How dithering can be the logo

- **Animated dithered gradient mark** — radial/linear gradient drifting over time, ordered (Bayer 8x8) dithered to 1-bit, white wordmark on top. The gradient *is* the logo; the dither is what makes it feel like dither.
- **Knockout wordmark** — text is the window through which the dithered gradient shows; surroundings are solid bg. Inverse also works.
- **Mark only** — a circular/pill "d" tile filled with the moving dither, sits as a small floating chip on the homepage.
- **Hover dissolve** — clean text → noise → dither pattern → resolves back. Dither as a transition state.
- **Static SVG fallback** — same Bayer matrix baked into an SVG `<pattern>` so the logo still has identity without JS.

## Variants to prototype

1. Pill chip — dithered radial gradient bg, white "dither" text, ~36–44px tall, sits floating top-left on hero.
2. Big hero block — wide rectangle, dithered linear gradient sweeping diagonally, wordmark centered.
3. Knockout — black bg, "dither" cut out, dithered gradient visible through letters.
4. Mark — square tile with single "d" (or just the gradient), can pair with text logotype.

## Implementation notes

- Canvas 2D, render at low res (e.g. 320×80) and upscale with `image-rendering: pixelated`. Cheap, crisp dither pixels.
- Bayer 8×8 ordered dither, threshold per-pixel from gradient value 0..1.
- 2-color output (bg + accent), or 3-step (bg / mid / accent) if we want more depth.
- Animate gradient center / angle with `requestAnimationFrame`, modulo time. Pause when off-screen / `prefers-reduced-motion`.
- White text overlaid via absolute-positioned `<span>` so it stays sharp (not pixelated).
