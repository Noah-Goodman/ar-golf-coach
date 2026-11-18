# GolfAR

Mixed reality golf coach for Meta Quest 3. You hit a real ball with a real club. A Garmin R10 measures the shot, and the headset draws the ball flight, a face/path impact diagram at the ball, and a stats card in the top-right of your view, all over passthrough.

```
R10 --Bluetooth--> connector (Mac) --ws://127.0.0.1:8765--> adb reverse --USB--> Quest (R10Receiver) --> visuals
```

## Requirements

- Unity 6 (6000.3), Android build support
- Meta XR All-in-One SDK (already in `Packages/manifest.json`)
- Meta Quest 3 in developer mode, USB cable
- Mac with Node.js 22+ and adb, for the connector (see `../connector/README.md`)

## Open the project

1. Unity Hub > Add > Add project from disk > `ar-golf-coach/GolfAR`. The first open takes a few minutes.
2. Open `Assets/Scenes/SampleScene`.
3. If asked, import **TMP Essentials** (Window > TextMeshPro > Import TMP Essential Resources), with Play stopped.

## Scene

| Object | What it does |
|---|---|
| `[BuildingBlock] Camera Rig` | Headset camera and controllers. Tracking Origin = Floor Level. |
| `[BuildingBlock] Passthrough` | Shows the real room. |
| `BallAnchor` | Sits on the real ball; its blue (forward) axis is the target line. All visuals are drawn from here. |
| `ShotVisualization` | Holds every script below. |

Components on `ShotVisualization`:

| Component | Job |
|---|---|
| Shot Visualization Controller | Receives shots and drives the visuals. Tee Origin = BallAnchor. |
| Trajectory Visualizer | Animated ball flight and faded trails of the last shots. |
| Club Delivery Visualizer | Impact diagram: face (orange), path (blue), face-to-path arc. Angles drawn x3. |
| Shot Stats Panel | Stats card. Placement = In Room: appears in front of you at launch and stays put; grab the bar under it to move it. Its top-right button hides or shows the shot lines. |
| Ball Placer | Marks the ball and target with a controller ray, and shows the setup card (left of the stats card) with the steps, the target line checkbox and the redo buttons. Puts the camera at eye height in the Editor. |
| R10 Receiver | Connects to the connector and forwards each shot. |
| Mock Shot Source | Fake shots for testing. |

Scripts: `Assets/Scripts/` (BallPlacer, R10Receiver) and `Assets/Scripts/ShotVisualization/` (visuals, see its README).

## Using it

1. Start the connector on the Mac: `cd connector && npm start` (the R10 must not be connected to a phone or OpenGolfSim).
2. Plug in the Quest and Build And Run (File > Build Profiles > Meta Quest). Keep the cable connected.
3. In the headset:
   - The setup card next to the stats card lists the steps. Either controller works; the ray comes from the one whose trigger your finger is on.
   - Point the ray at the real ball and pull the trigger. A green ring and ball show where it will be marked. The ray lands on real surfaces through depth sensing (accept the spatial data prompt on first launch); without depth it lands on the floor.
   - Point the controller at your target and pull the trigger. The target line follows the controller while you aim.
   - Put the controller down and hit with your club.
4. On the setup card, point and pull the trigger to toggle **Show target line**, or to press **Re-mark ball** or **Re-aim**. To move either card, point at the bar under it, hold the trigger, move, and release. **B** or **Y** restarts from marking the ball. Place each new ball on the same spot so the marking stays valid.

## Testing without the R10

- **Editor, preset shots:** Play, click the Game view, press `1`-`6` (`C` clears). Use the Scene view to look around; the background is black because passthrough only works on the headset.
- **Editor, through the connector:** `cd connector && npm run fake`, press Play, then press Enter in Terminal for each shot. The Console shows `[R10] Connected to bridge`.
- **Headset:** after marking the ball, press **A** for a preset shot.

## Settings worth knowing

- **Shot Stats Panel > Room Offset / Meters Per Pixel**: where the card appears at launch (m, from the eyes) and its size. Defaults 0.25, 0, 1.3 and 0.0008. The setup card uses the same size and appears to its left.
- **Controller > Hide Lines After Seconds / Line Fade Seconds**: the flight lines and impact diagram fade out this long after the ball lands (10 s, over 1 s). **Hide lines** / **Show lines** on the stats card toggles them; shown lines stay until pressed again, and the next shot starts the 10 s again.
- **Trajectory Visualizer > Show ...**: ground shadow, target line, apex label and landing marker are turned off, so only the trail, the impact diagram and the card appear.
- **Controller > Settings > Distance Scale**: 1 = real size, 0.05 = fits in a room.
- **Controller > Reveal Stats After Landing**: predict-then-reveal drill.
- **Ball Placer > Show Direction Line / Direction Line Length**: the target line's starting state (on) and length (5 m).
- **Ball Placer > Editor Eye Position / Angles**: camera pose in the Editor only. Setup is skipped there; click the setup card's checkbox with the mouse.

