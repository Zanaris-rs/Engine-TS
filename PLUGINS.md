# Plugins

Opt-in features for this fork, kept isolated so that syncing with `upstream/LostCityRS/Engine-TS`
stays trivial.

## The rule

All plugin logic lives in **new files** under `src/plugins/`. New files never conflict on a rebase.

An upstream file may gain **at most two added lines** — one import, one call — and **must never have
an existing line modified**. Both carry a `// @plugin-hook` marker so a conflict is greppable.

Every hook returns a "not handled" default, so with no configuration this fork behaves byte-for-byte
like stock upstream.

## Configuration

Precedence: environment variable → `data/config/plugins.json` (gitignored) → default.

| Env | JSON key | Default | Effect |
| --- | --- | --- | --- |
| `PLUGIN_IDLE_TIMEOUT` | `idleTimeout` | `90` | Seconds of no client input before logout. `90` or less = stock behaviour. |
| `PLUGIN_LOGIN_MOTD` | `loginMotd` | `''` | Message sent on login. Empty disables. |
| `PLUGIN_ANNOUNCE_INTERVAL` | `announceInterval` | `0` | Seconds between world broadcasts. `0` disables. |
| `PLUGIN_ANNOUNCE_MESSAGE` | `announceMessage` | `''` | Message used by the above. Empty disables. |

`start.js` spawns the engine with inherited environment, so `PLUGIN_IDLE_TIMEOUT=300 ./start.sh`
works from the repository root.

## Seam manifest

Mirrored in `tools/plugins/VerifySeams.ts`. Keep both in step when adding a seam.

### `src/network/game/client/handler/IdleTimerHandler.ts`

```ts
import Plugins from '#/plugins/Plugins.js'; // @plugin-hook
```

First line of `handle()`:

```ts
        if (Plugins.onIdleTimer(player)) return true; // @plugin-hook
```

### `src/engine/entity/Player.ts`

```ts
import Plugins from '#/plugins/Plugins.js'; // @plugin-hook
```

End of `onLogin()`, immediately before `this.isActive = true;`:

```ts
        Plugins.onLogin(this); // @plugin-hook
```

### `src/engine/World.ts`

```ts
import Plugins from '#/plugins/Plugins.js'; // @plugin-hook
```

First line inside the `try` in `cycle()`:

```ts
            Plugins.onCycle(this.currentTick); // @plugin-hook
```

## Plugins

- **`idle_timeout`** — the real feature. Idleness is measured by the *client*: it sends
  `IDLE_TIMER` after 90s with no mouse or keyboard input, then re-sends every 10s while still idle.
  The plugin counts that packet streak per player and only sets `requestIdleLogout` once
  `idleTimeout` seconds have accumulated. It never touches `preventLogoutUntil`, so the logout
  button, the combat antilog, `::kick`, world shutdown and the 30s/60s connection timeouts are all
  unaffected.
- **`login_motd`** — trivial; exists to exercise the player-lifecycle seam.
- **`world_announce`** — trivial; exists to exercise the world-cycle seam, in the busiest upstream
  file, as a stress test of the discipline.

## Updating from upstream

```sh
git fetch upstream
git rebase upstream/289          # only the seam commit can conflict, and it is 6 lines
npx tsx tools/plugins/VerifySeams.ts
npm run lint
```

Keep the seam edits in a single commit, separate from commits that add `src/plugins/**`. If a seam
conflicts, take upstream's version of the surrounding code and re-add the two marked lines from the
manifest above.
