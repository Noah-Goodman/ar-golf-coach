# R10 bridge

A macOS command-line bridge between a Garmin Approach R10 launch monitor and the Unity app on a Meta Quest 3. It connects to the R10 over Bluetooth LE, decodes each shot, and serves it as JSON over a WebSocket on `127.0.0.1:8765`. The headset reaches that port over USB through `adb reverse tcp:8765 tcp:8765`, which the bridge applies (and re-applies) on its own.

```
R10 --BLE--> bridge (Mac) --ws://127.0.0.1:8765--> adb reverse --USB--> Quest 3
```

## Prerequisites

- Node.js 22 or newer.
- adb (Android platform-tools), for example `brew install --cask android-platform-tools`.
- Quest in developer mode, connected by USB, with "Allow USB debugging" accepted in the headset. `adb devices` should list it as `device`, not `unauthorized`.
- Bluetooth permission for your terminal app. The first run triggers the macOS prompt; if you missed it, enable the terminal under System Settings > Privacy & Security > Bluetooth and restart the terminal.

```
npm install
```

## Only one connection at a time

The R10 accepts a single Bluetooth connection. Close the Garmin Golf app on your phone (or turn its Bluetooth off) and quit OpenGolfSim before starting the bridge, or the bridge will never find the R10.

## First run: pairing

With no `config.json`, or no `r10Id` in it, the bridge starts in pairing mode.

1. Put the R10 in pairing mode (solid blue light).
2. `npm start`
3. Accept the macOS pairing prompt when it appears.

The R10's id is saved to `config.json` and later runs connect to it directly. To pair a different unit, delete `r10Id` from `config.json`.

The first read is always rejected with "Encryption is insufficient"; that is what makes macOS start pairing, and the bridge keeps the connection open while it does. If the bridge then reports that the R10 dropped the connection, the R10 is not in pairing mode: it hangs up on any pairing request outside that mode. Hold its power button until the light is solid blue. Flashing blue means it is trying to reconnect to a phone it already knows, so turn Bluetooth off on that phone too. The bridge keeps retrying, so there is no need to restart it.

## Normal run

```
npm start
```

Startup prints the WebSocket URL, the packet log path and whether a saved R10 id exists. After that every line is timestamped: R10 state, battery and errors, headset attach/detach, adb reverse applied, WebSocket client connect/disconnect, and one line per shot. Ctrl+C stops cleanly; a second Ctrl+C exits immediately.

Every raw notification is logged to `logs/<timestamp>.jsonl` as `{"t": <unix ms>, "char": "...", "hex": "..."}`.

`config.json` (see `config.example.json`):

| Key | Default | Meaning |
|---|---|---|
| `port` | `8765` | WebSocket port, and the port forwarded by adb reverse |
| `r10Id` | `null` | Saved R10 peripheral id; `null` means pair on start |
| `logDir` | `"logs"` | Packet log directory, relative to this folder |

## Tools

Neither tool needs an R10. Both accept `--port <n>` to override `config.port`, so they can run beside each other or beside the bridge.

```
npm run fake -- [--interval <seconds>] [--no-club] [--seed <n>] [--port <n>]
```

Serves a `ready` status and a made-up shot each time you press Enter, and every `--interval` seconds if given. About one shot in four has no club data, unless `--no-club` makes them all club-less. `--seed` makes the sequence repeatable. Shots go through the same unit and sign code as live data.

```
npm run replay -- <file.jsonl> [--print] [--speed <factor>] [--fast] [--port <n>]
```

Plays a packet log back as the messages the bridge would have sent. It waits for a client, then plays with the original timing (`--speed 4` is four times faster, `--fast` has no delays). `--print` needs no server or headset: it prints each shot's raw values, before sign correction, next to the v1 values. Bad lines are reported with their line number and skipped.

If the port is taken, the bridge and both tools print one line saying so and exit 1: another bridge or tool is probably still running.

## Messages (v1)

One JSON object per WebSocket text frame. Only one client is served at a time; a new connection replaces the old one, which is closed with code 1000 and reason `replaced`. A client receives the latest status as soon as it connects. Anything the client sends is ignored.

Shot:

```json
{ "v": 1, "type": "shot", "shotId": 1234, "receivedAt": 1761500000123,
  "ball": { "speedMph": 132.4, "launchAngleDeg": 14.2, "launchDirectionDeg": 1.8,
            "backspinRpm": 3100, "sidespinRpm": -450, "spinMeasured": false },
  "club": { "speedMph": 92.1, "faceAngleDeg": 2.5, "pathAngleDeg": -1.5, "attackAngleDeg": -3.0 } }
```

- `ball` and `club` always have every key; a value the R10 did not send is `null` (club data is often missing).
- Speeds in mph, angles in degrees, rounded to 2 decimals. Spin in rpm.
- Horizontal angles (`launchDirectionDeg`, `faceAngleDeg`, `pathAngleDeg`): positive = right of the target line, seen from behind the ball, whatever the golfer's handedness. Launch and attack angle: positive = up.
- `sidespinRpm` is passed through with the sign the R10 sends; which direction positive means is not yet established.
- `spinMeasured`: `true` when the R10 measured spin, `false` when it estimated it, `null` when it did not say.
- `receivedAt`: Unix ms when the shot's last notification arrived.

Status:

```json
{ "v": 1, "type": "status", "connected": true, "ready": true, "state": "ready",
  "error": null, "batteryPct": 87, "firmware": "4.40" }
```

- `state`: `needs-pairing`, `scanning`, `connecting`, `ready`, `busy`, `standby` (going to sleep; the bridge wakes it), `disconnected`.
- `error`: `null`, `overheated`, `interference`, `not-level` or `unknown`. `ready` is true only when `state` is `ready` and `error` is `null`.

## Sign test

The direction of the horizontal values is set by `SIGN` in `src/toMessage.js`. `launchDirection` is `-1` (a guess taken from OpenGolfSim); `faceAngle`, `pathAngle` and `sidespin` are `+1`. None is confirmed on hardware yet. To check them:

1. Run the bridge, so packets are logged.
2. Right-handed, hit a few obvious pushes (ball starts right of the target), then a few obvious pulls (ball starts left).
3. Stop the bridge and run `node tools/replay.js logs/<file>.jsonl --print`.
4. For each push, the v1 `launchDirectionDeg` should be positive and for each pull negative. A face pointing right of the target should give a positive `faceAngleDeg`, and a club travelling to the right through impact a positive `pathAngleDeg`. Where a value has the wrong sign, flip that entry in `SIGN`. Note which way the ball curved against the sign of `sidespinRpm`, to settle what its sign means.
5. Repeat left-handed. This shows whether the R10 flips face and path signs for left-handers. Keep the logs in `test/fixtures/` (for example `signtest-right-push.jsonl`).

## Tests

```
npm test
```

No R10, headset, adb or fixed port is needed.
