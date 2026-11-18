# Shot Visualization

Turns one launch-monitor shot into visuals for the player: the ball flight, an impact diagram at the ball, and a stats card.

## Setup (about 5 minutes)

1. Copy this `ShotVisualization` folder into `Assets/Scripts/`.
2. If Unity asks to import **TMP Essentials**, click Import. (Or Window > TextMeshPro > Import TMP Essential Resources.)
3. In the scene, create an empty GameObject called `ShotVisualization` and add the **Shot Visualization Controller** component. It adds the trajectory, impact diagram, and stats card components by itself on Play.
4. Set **Tee Origin** to the transform that sits on the real ball, with its blue (forward) axis pointing at the target. Until the AR anchoring is done, leave it empty and the controller's own position is used.
5. Add **Mock Shot Source** to the same object and press Play. Keys `1` to `6` fire preset shots, `Space` fires the JSON in the text box, and `C` clears. The same actions are in the component's ⋮ menu.

For the Quest build, make one material with the shader `Universal Render Pipeline/Particles/Unlit` (Surface Type: Transparent) and drag it into the **Line Material** slot on the trajectory and impact diagram components. Without it the lines can turn pink in a build, because Unity strips shaders nothing references.

## Sending real shots in

Whoever receives the R10 data only needs one line:

```csharp
ArGolfCoach.Visualization.ShotEvents.PublishJson(jsonString);
```

or, with an object already built, `ShotEvents.Publish(shotData)`. Both are safe to call from a background thread. If OpenGolfSim gives us its own trajectory points, use `controller.Visualize(shot, BallFlightSimulator.FromPoints(points, timeStep))` and the built-in flight model is skipped.

The JSON field names must match `ShotData.cs` exactly (`ball.speedMph`, `club.faceAngleDeg`, and so on). Extra fields are ignored. A missing `club` block is fine: the impact diagram shows "No club data" and the card drops the club rows.

## Sign conventions to confirm with the pipeline

| Field | The code assumes |
|---|---|
| `launchDirectionDeg` | + = ball starts right of target |
| `faceAngleDeg` | + = face points right (open for a right-hander) |
| `pathAngleDeg` | + = club moving right (in-to-out for a right-hander) |
| `attackAngleDeg` | − = hitting down |
| `sidespinRpm` | + = ball curves right (the connector sends it this way). By default only its size is used and the curve direction comes from face minus path; shots without club data use its sign |

All of these are switches under **Settings** on the controller. **Sidespin Convention** can be set to `PositiveCurvesRight` to take the curve direction from sidespin instead of face minus path.

## What each file does

| File | Job |
|---|---|
| `ShotVisualizationController.cs` | The one component in the scene. Listens for shots and drives the three visuals. |
| `Data/ShotData.cs` | The shot, matching the JSON. |
| `Data/ShotEvents.cs` | The hand-off point from the data code to the visuals. |
| `Data/VisualizationSettings.cs` | Handedness, sign conventions, units, scale, and playback speed. |
| `Data/BallFlightSimulator.cs` | Carry flight from launch data (drag, lift, spin decay). |
| `Data/ShotShapeClassifier.cs` | Names the shot ("Push slice") and picks one cue. |
| `Rendering/TrajectoryVisualizer.cs` | Animated ball, trail, flight line, ground shadow, apex and landing labels, and faded history. |
| `Rendering/ClubDeliveryVisualizer.cs` | Top-down impact diagram on the mat: target line, path arrow, clubface, and face-to-path arc. |
| `Rendering/ShotStatsPanel.cs` | World-space stats card. |
| `Rendering/VizUtil.cs` | Colors, line and label helpers, and the billboard script. |
| `Testing/MockShotSource.cs` | Fake shots for testing. Remove once real data flows. |

## Settings worth knowing

- **Distance Scale** (controller): 1 is real size, so a 200 yd shot flies 200 yd past the net. 0.05 shrinks the flight to fit a room.
- **Reveal Stats After Landing** (controller): holds the card until the ball lands, for the predict-then-reveal drill.
- **Angle Exaggeration** (impact diagram): real face and path angles are 1 to 3 degrees, too small to see, so they are drawn ×3 and labeled that way.
- **Offset From Ball** (impact diagram): moves the diagram off the real ball if it gets in the way of the club.
- **Placement** (stats card): `NearTee` pins the card beside the ball, and `FollowHead` keeps it floating in view.
- **History Count** (trajectory): how many earlier shots stay on screen, faded, as a dispersion view.

## Accuracy

The flight model was checked against TrackMan PGA Tour averages. Driver, 7-iron, and pitching wedge carry and apex come out within about 5%. Indoors the R10 estimates spin instead of measuring it, so curve amounts are approximate, and the card marks spin as "est." when `spinMeasured` is false. The card labels carry, offline, apex, and hang time as simulated.

The shot-name thresholds (2° for push or pull, 1° and 4.5° face-to-path for fade and slice) are constants at the top of `ShotShapeClassifier.cs`.
