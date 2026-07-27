# Worm Bits

Worm Bits is an original, LNbits-branded, turn-based artillery game packaged
as an LNbits WebAssembly extension.

Phase 1 is a local hot-seat game for two teams. It includes:

- deterministic seeded terrain and command recording;
- three characters per team;
- walking, jumping, aiming, and charged shots;
- a bolt launcher, pulse grenade, and skip-turn action;
- destructible terrain, blast damage, knockback, fall damage, and water;
- match replay and restart controls; and
- original Canvas artwork and generated sound effects.

The game and physics are dependency-free JavaScript. The extension's WASM
component is intentionally empty in Phase 1 because local matches do not need
backend routes or permissions. Multiplayer APIs and persistence belong to later
phases.

## Development

Use Node.js 20 or newer for the simulation and Chromium tests.

Run the focused checks from this directory:

```bash
npm test
```

Rebuild the browser bundle and minimal component from the repository root:

```bash
node wormbits/dev/build_browser.mjs
uv run python wormbits/dev/build_wasm.py
```

The installable extension archive must have `config.json` at its root alongside
the `static`, `ui`, and `wasm` directories.

## Controls

- `A` / `D` or left / right arrows: move
- `W` or Shift: jump
- up / down arrows: aim
- hold and release Space: charge and fire
- `1`: bolt launcher
- `2`: pulse grenade
- `X`: skip turn

Equivalent on-screen controls are provided for pointer and touch input.

## Branding

The LNbits logo in `static/assets` is copied from the LNbits repository.
All remaining visual elements are drawn specifically for Worm Bits.
