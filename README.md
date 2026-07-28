# Worm Bits

Worm Bits is an original, LNbits-branded, turn-based artillery game packaged
as an LNbits WebAssembly extension.

Worm Bits includes a local hot-seat mode and reliable online rooms for two to
four players. The game includes:

- deterministic seeded terrain and command recording;
- three characters per player-controlled team;
- walking, jumping, aiming, and charged shots;
- a bolt launcher, pulse grenade, and skip-turn action;
- destructible terrain, blast damage, knockback, fall damage, and water;
- local match replay and restart controls;
- multiplayer lobbies, player names, ready state, and host-controlled starts;
- backend-validated actions and WebSocket invalidation events;
- durable deterministic snapshots and synchronization recovery;
- reconnectable private player tokens kept out of invite URLs;
- disconnect detection, timeout forfeits, and automatic host transfer;
- read-only spectators and persistent action rate limiting;
- optional equal entry fees collected into the creator's LNbits wallet;
- idempotent winner payouts, draw splits, pre-start refunds, and safe retry
  handling; and
- original Canvas artwork and generated sound effects.

The game and physics are dependency-free JavaScript. The same deterministic
simulation runs in the browser and inside the WASM backend. Clients render
optimistically, but the backend checks the player token, room revision, client
sequence, active team, simulation tick, command shape, and rate window before
persisting an action.

WebSockets are invalidation signals rather than an authority: every message
causes clients to fetch the durable room snapshot. A three-second polling
fallback provides recovery if a socket disconnects or an update is missed.

## Multiplayer flow

1. An authenticated LNbits user creates a two-to-four-player room. Paid rooms
   use one of that user's wallets as the pot wallet.
2. The host shares the public room URL. The URL never contains the host token.
3. For paid rooms, every player supplies a payout Lightning address and pays
   the same entry invoice before they can ready up.
4. Players join with a display name, ready up, and the host starts the match.
5. Each player controls the team matching their lobby slot.
6. Spectators receive the same snapshots but cannot submit game actions.
7. Participants are shown offline after 15 seconds without a heartbeat.
8. A player forfeits after 75 seconds offline. The next connected player becomes
   host when the current host disconnects.

The backend derives the winner only from its deterministic durable simulation.
The winning slot receives the pot; a draw returns an equal share to every paid
entrant. A paid player who leaves before the match starts receives a refund.
Settlement records are written before Lightning is called, so repeated requests
do not repeat completed payments. Definite failures can be retried. Ambiguous
interruptions and pending outgoing payments are held for manual review instead
of being retried blindly.

Paid rooms are custodial rather than trustless. The creator controls the pot
wallet and can move its balance outside Worm Bits. The wallet must also retain
enough extra balance to cover outgoing Lightning routing fees.

## Development

Use Node.js 20 or newer for the simulation and Chromium tests.

Run the focused checks from this directory with Node.js 20 or newer:

```bash
npm test
```

Rebuild the browser and backend bundles:

```bash
npm run build:browser
npm run build:backend
```

Build the installable WASM component:

```bash
npm run build:wasm
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

The LNbits logo in `static/assets` is copied from the LNbits repository. All
remaining visual elements are drawn specifically for Worm Bits; no Team17 game
artwork is included.
