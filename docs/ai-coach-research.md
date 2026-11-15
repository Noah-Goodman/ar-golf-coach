# Goal-aware AI coaching from Garmin R10 shots

Research date: November 15, 2026. This is a proposed design and starter coaching library, not a validated coaching system. Repository findings are based on the current source. Linked manufacturer documentation and PGA instruction support the golf principles; thresholds, practice blocks, and app behavior below are design recommendations that need testing with a qualified golf coach.

## Recommendation

Prototype with **Gemini 4 Argon (`gemini-4-argon`)** in Google AI Studio when coaching quality is the priority. Its documented reasoning and structured-output support suit the task of comparing hypotheses and selecting a grounded intervention. Benchmark **Gemini 4 Hydrogen (`gemini-4-hydrogen`)** as the less expensive, free-tier-accessible option for routine shot feedback. Neither has an established golf-coaching accuracy result for this application: choose the deployment model using the evaluation set below, not a general model ranking. Both accept video if that becomes a later input. [Google: Argon](https://aistudio.google.com/docs/models/gemini-4-argon), [Google: Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen).

Current standard API prices per million tokens are Argon $2 input / $10 output through November 30, 2026, increasing to $4 / $20 on December 1; Hydrogen is $1.50 / $7.50. Output billing includes thinking tokens. Argon has no free tier; Hydrogen lists one. Confirm prices and rate limits for the actual project before deployment. [Google pricing](https://aistudio.google.com/docs/pricing).

Build a pipeline with four responsibilities:

```text
R10 packet + player/club/intent + user goal + recent shots
  -> code validates data, computes metrics, evaluates goal
  -> select relevant coaching cards and competing explanations
  -> Gemini explains evidence and chooses a practice experiment
  -> code validates output; Unity presents praise, a cue, or a context request
```

The central distinction is **outcome -> impact explanation -> swing intervention**. The R10 can support an impact explanation, but its output does not uniquely identify a player's grip, wrist action, balance, or sequencing. Treat a swing intervention as a hypothesis to test, then use the next shots to see whether it helps.

## 1. What this repository actually supplies

The current route is the direct BLE bridge described in `connector/README.md`, even though some Unity comments still mention OpenGolfSim.

| Available input | Coaching use | Limitation |
|---|---|---|
| `ball.speedMph` | Distance potential; ball-speed goal | Need club, intended effort, and baseline |
| `ball.launchAngleDeg` | Initial vertical flight | Does not identify a top/thin or delivered loft by itself |
| `ball.launchDirectionDeg` | Where the ball starts | Requires confirmed sign and target alignment |
| `ball.backspinRpm`, `ball.sidespinRpm` | Flight shape and trajectory inputs | Spin provenance and sidespin direction matter |
| `ball.spinMeasured` | Spin-quality hint | One Boolean cannot establish that spin axis was measured |
| `club.speedMph` | Speed and impact-efficiency analysis | Can be missing; has device uncertainty |
| `club.faceAngleDeg`, `club.pathAngleDeg` | Face-to-path and start-line explanation | Signs are not hardware-confirmed; face is an estimate |
| `club.attackAngleDeg` | Upward/downward delivery | Not dynamic loft, low-point position, or proof of ground contact |
| `shotId`, `receivedAt` | Ordering and deduplication | Add session identity across reconnects |

`connector/src/decode.js` preserves missing fields as `null`; `connector/src/toMessage.js` converts units and forwards nulls. `Data/ShotData.cs` uses non-nullable floats/bools and has no per-field validity representation. Its `HasClubData` only checks club speed, so it cannot establish that face, path, or attack angle are present. Analyze the bridge JSON before information is lost, or add a separate validity-aware coaching DTO.

Compute in code, only when dependencies are valid:

```text
faceToPathDeg = faceAngleDeg - pathAngleDeg
smashFactor = ballSpeedMph / clubSpeedMph
totalSpinRpm = sqrt(backspinRpm^2 + sidespinRpm^2)
```

The latter assumes these are the verified orthogonal spin components expected by the project. A spin-axis estimate can be derived with `atan2` after the coordinate convention is confirmed; do not relabel it as an independent measurement.

Carry, offline distance, apex, and hang time are currently produced by `Data/BallFlightSimulator.cs`; they are **simulated**, not fields in the bridge shot message. Keep that provenance in the coaching payload. Its flight has fixed air density and no wind input. Use real-size coordinates before `distanceScale` or display exaggeration. For target-distance goals, use the down-target component as well as lateral error; radial carry alone can hide a large directional miss.

### Resolve these issues before using directional coaching

1. The bridge README explicitly says all horizontal sign choices still need the real push/pull test. The only included fixture is synthetic. Verify launch, face, path, and spin direction against observed shots, for both handednesses. Do not use unverified signs for swing corrections.
2. In `VisualizationSettings.SidespinRightRpm`, the default curve direction is inferred from face-to-path. Consequently, a rendered right curve is not independent confirmation of that same face-to-path explanation. Preserve a dependency graph such as `renderedCurve <- inferredSpinDirection <- faceToPath`.
3. In `ShotShapeClassifier.cs`, launch below 6 degrees becomes `Thin / topped`, and smash below 1.15 becomes `Mis-hit` regardless of club or intent. These are unsuitable diagnostic rules for the AI. A low punch can be intentional; smash depends on loft. Keep shape observations separate from contact hypotheses.
4. The classifier's slice cue always asks for a more outward path. That can worsen a shot whose path is already too far outward. Select the intervention from the face/path combination, not the shape name alone.
5. Its fade/draw praise and miss flag do not consider the user's goal. The coaching decision needs the new goal evaluator, rather than reusing `isMiss` as the feedback trigger.

Garmin publishes approximately +/-1 mph ball speed, +/-3 mph club speed, +/-1 degree launch angle/direction, and +/-2 degrees for its calculated face angle. These are specifications, not standard deviations or calibrated per-shot probabilities. No path uncertainty should be invented from that table. Small differences should not produce confident corrections. [Garmin accuracy](https://support.garmin.com/en-SG/?faq=kj37CgzvwM98hC9WPrIQm5).

Also correct the README's blanket statement that indoor spin is estimated: compatible RCT balls can enable measured total spin indoors, while the axis can still be calculated. Retain separate provenance for spin magnitude and spin axis; `spinMeasured: true` alone is insufficient. [Garmin RCT guidance](https://support.garmin.com/fr-CA/?faq=COFCXdRAJv2m8r9MBtLrf8), [Garmin R50/R10 comparison](https://www.garmin.com/en-US/blog/outdoor/3-key-differences-between-garmin-approach-r50-and-r10/).

## 2. Make the user-defined goal the feedback gate

The goal answers whether the shot or practice block succeeded. The golf model answers which change might improve a goal-relevant failure. A technically unusual shot is not automatically a failure.

Represent a goal as a structured object even if the user describes it in plain language. Resolve ambiguous terms such as "distance" into carry versus total distance, and "dispersion" into spread versus target accuracy. Confirm that interpretation when the user creates the goal. The current simulator only supplies carry flight, so a total-distance goal requires an additional roll model or another data source.

```json
{
  "goalId": "driver-dispersion-v1",
  "description": "Keep my driver in a tighter area around the target",
  "clubId": "driver",
  "shotIntent": "stock_full",
  "metric": "p80_target_error_yd",
  "direction": "decrease",
  "target": 20,
  "unit": "yd",
  "window": { "type": "block", "shots": 20, "minimumShots": 10 },
  "tolerance": 2,
  "baselineValue": 28,
  "baselineSource": "same_setup_previous_block",
  "constraints": [
    { "metric": "median_carry_yd", "operator": ">=", "value": 205 }
  ]
}
```

All example targets, tolerances, and window sizes here are illustrative product choices, not universal golf standards. Set them from player ability, goal difficulty, observed variability, and device uncertainty. A tolerance is a decision band, not a confidence interval. Require a meaningful margin before declaring progress; use resampling/uncertainty intervals for aggregate metrics when the sample supports it.

| Goal | Suggested operational definition | How to evaluate |
|---|---|---|
| Tighter target dispersion | 80th percentile of landing error from the intended landing point | Compare completed equal-size blocks; also track lateral/longitudinal bias |
| More repeatable grouping | Lateral and depth spread about the group's own center | Keep separate from accuracy: a tight group can be far off target |
| More distance | Median carry for a selected club and intent | Track lateral-error constraint; distinguish longer from better |
| Higher ball speed | Median `ball.speedMph` | Praise a shot in its individual target band; judge sustained improvement across a block |
| Better contact efficiency | Club-specific smash distribution plus verified strike feedback | Never use a driver target for wedges |
| Desired trajectory | Player/club-specific launch or apex band | Distinguish launch angle from peak height; label apex simulated |
| Shape control | Intended start line plus acceptable curve/landing window | A playable intentional fade/draw is success |
| Distance consistency | Carry spread for the same club and effort | Include real mishits; exclude only invalid measurements with a reason |

For target dispersion, with lateral landing `x`, down-target landing `z`, and intended landing distance `d`, define each error as `sqrt(x*x + (z-d)*(z-d))`. Evaluate its percentile across shots in a common target frame. If targets differ, transform each shot to its intended target frame or separate the groups. Retain target bias and spread so the coach can distinguish aim problems from inconsistent delivery. Do not claim a 20-shot estimate proves long-term improvement.

Suggested application-owned decision order:

1. **`data_issue`**: relevant fields invalid, stale/mismatched target, unverified signs, or a device error. Explain what to check; no swing fix.
2. **`collecting_baseline` / `insufficient_evidence`**: not enough comparable shots, uncertainty overlaps the decision boundary, or the required baseline is missing. Encourage continued practice or request the one missing input.
3. **`praise`**: target met within the defined acceptance band and selected constraints met. Example: "Good job—141 mph is in your ball-speed target. Repeat that feel." Do not attach an unrelated swing correction.
4. **`progress`**: a comparable block improved materially but the target is not yet met. Reinforce what the user is practicing.
5. **`coach`**: a goal-relevant miss is meaningful and there is enough evidence for an actionable experiment. Choose one priority.
6. **`observe`**: the goal was missed but the cause is ambiguous, or an active drill needs more shots. Describe the miss without inventing a fix.

A single-shot speed goal can receive immediate praise; a dispersion goal needs a group. During a group, report a shot's contribution without declaring the whole goal achieved. Do not alternate between opposed tips on every shot: retain an active drill for a defined block unless new evidence contradicts it. Recompute comparable block statistics before changing the plan.

A distance or speed goal may explicitly allow increased dispersion. Report a chosen tradeoff accurately. Only enforce constraints the player/coach selected. Avoid unsolicited mechanics advice merely because a secondary metric differs from a tour average.

## 3. Golf knowledge the context must contain

Keep a short verified foundation in every request:

- **Start direction:** local face orientation is the main influence; path also contributes. Use the reported launch direction for the start observation. Face at impact and face at address are different quantities. [Trackman face angle](https://www.trackman.com/blog/what-is-face-angle).
- **Curvature:** for centered contact, face relative to path predicts the curve tendency. Use global right/left first, then handedness-aware draw/fade labels. Matching face and path can produce a straight shot that starts off target. There is no universal face-to-path-to-yards conversion. [Trackman face-to-path](https://www.trackman.com/blog/face-to-path).
- **Contact exception:** off-center wood/driver impacts can change curvature through gear effect. A curve that conflicts with delivery is a reason to check strike and data quality, not proof that the golfer needs a different path. [Titleist gear effect](https://www.titleist.com/learning-lab/performance/golf-gear-effect).
- **Vertical flight:** delivered loft, speed, contact, and spin contribute. High launch and high apex are different; neither is inherently bad. Dynamic loft is not in this project's shot schema. [Trackman dynamic loft](https://www.trackman.com/blog/dynamic-loft).
- **Attack angle:** this describes clubhead motion, not face loft or impact position. A downward strike is normal for many shots from the ground; an upward driver delivery can help optimize distance but is not a universal scoring requirement. [Trackman attack angle](https://www.trackman.com/blog/attack-angle).
- **Spin loft:** it is a 3D angle between delivery and face orientation. Dynamic loft minus attack angle is only an approximation; launch angle minus attack angle is not a valid replacement. This schema cannot calculate true spin loft. [Trackman spin loft](https://www.trackman.com/blog/spin-loft).
- **Efficiency:** smash varies by club/loft and more than centeredness. A lower ratio alone cannot identify a heel, toe, or ground strike. [Trackman smash factor](https://www.trackman.com/blog/smash-factor).
- **Distance optimization:** useful launch/spin combinations depend on speed, equipment, and the player's objective. Do not prescribe one driver spin or launch number to every golfer. [Titleist driver fitting principles](https://www.titleist.com/learning-lab/titleist-expertise/the-complete-guide-to-golf-drivers).

Use personal references from the same device, club/loft, ball type, lie, and shot intent. A proposed starting protocol is 15–20 baseline shots per stock club, followed by equal-size comparison blocks. Keep valid mishits in outcome statistics. A separate coach-reviewed set of representative solid shots can establish a useful trajectory reference, but should not erase misses from the player's performance record. Tour averages are illustrative references, not pass/fail targets.

## 4. From miss to intervention

These are candidate branches for a knowledge base. The branch must be goal-relevant and survive input-quality checks. Actual body faults remain unobserved until there is video, a setup check, impact evidence, or a coach's observation.

| Observed goal-relevant pattern | Impact hypothesis to examine | First useful experiment | What should change |
|---|---|---|---|
| Starts right with little curve | Face and delivery directed right; alignment may contribute | K01 start line; check setup | Start error decreases without a new curve |
| Starts left with little curve | Face and delivery directed left | K01, mirrored | Same |
| Excessive right curve with path near the intended corridor | Face too far right relative to path, or strike effect | K02 face control after K04 strike check when needed | Curve decreases while start/landing stay acceptable |
| Excessive right curve with markedly leftward path | Large delivery mismatch; face and path may both matter | K03 path corridor, then K02 if face remains a problem | Path approaches intended corridor; curve and goal error improve |
| Excessive right curve despite a far-right path | Face is even farther right, or strike/data exception | K02 or K04; avoid an automatic farther-right path cue | Smaller delivery mismatch without a larger push |
| Excessive left curve | Opposite delivery mismatch or gear effect | K02/K03 mirrored; K05 grip only after checking setup | Less excessive curve with acceptable start |
| Short carry with normal club speed and reduced ball speed | Less effective impact, larger delivered loft, ball/lie difference, or measurement issue | K04 contact map; K06 only when turf evidence supports it | Ball speed/strike consistency improves for comparable swings |
| Short carry with both speeds lower, efficiency similar | Less speed/effort, different intent, or fatigue | Confirm full-shot intent; K08 if speed is the chosen goal | Sustainable ball-speed improvement within chosen constraints |
| Low flight for this club/intent | Low delivered loft, contact/strike height, low speed/spin, or setup | K04; K07 for driver; K09 for verified trajectory practice | Desired flight band with adequate carry/contact |
| High, short flight for this club/intent | Excess loft/spin, inefficient contact, conditions, or equipment | Verify spin and strike before K09 or fitting review | Goal-relevant carry/trajectory improves |
| Wide grouping across a block | Variable face, path, contact, or speed | Choose the variable whose repeated changes best align with goal error | Spread and target error improve on a fresh block |

Similar misses can require different advice. A right-handed shot with face +1 and path -7 is not the same intervention as face +9 and path +5, even though both have a positive face-to-path. Likewise, a face left of target can still produce right curvature if the path is farther left. Do not use "open" without stating relative to target or path.

### Starter coaching cards

These cards adapt published coaching concepts into app experiments. Their AR presentation, eligibility checks, repetition counts, and success checks are proposed application design. Have a PGA professional review them and the completed corpus. Source inclusion does not constitute approval by the source organization.

**K01 — Start-line rehearsal.** Use for a repeated start-direction miss, after checking monitor/target alignment. Select an intermediate spot on the intended start line. Aim the face, set the stance, and make controlled swings starting the ball over the spot. In AR, display a start corridor. Check actual launch direction and landing error; don't teach the player to cure a delivery fault only by aiming farther off line. Suitable for either hand. [PGA start-line drill](https://www.pga.com/story/3-fun-drills-to-dial-in-your-driving-chipping-and-putting).

**K02 — Face-control experiment.** Use when the face/path relationship is a credible contributor and path is already usable. Start with short controlled swings and an intermediate start target. Practice a small change in face delivery, then inspect both launch and curve. For right-curving centered shots the experiment is a face less right relative to the path; reverse for left curvature. Do not tell every slicer to roll the wrists, strengthen the grip, or swing farther outward. Use an AR face/path diagram to explain the requested impact change. [PGA face/path swing station](https://www.pga.com/story/a-swing-station-setup-and-drill-to-help-fix-your-slice).

**K03 — Path corridor.** Use when a repeated path departure is large enough to be credible and relevant to the player's intended shape. Show a modest AR club-travel corridor; rehearse slow swings through it, then controlled shots. Move the corridor toward the intended delivery, not automatically in-to-out. Keep a separate start-line check so changing path does not hide a face problem. This trains an impact condition without asserting an over-the-top body motion. [PGA path practice concept](https://www.pga.com/story/how-to-fix-your-slice-with-an-alignment-stick).

**K04 — Strike map.** Use for efficiency loss or a conflict between spin/flight and delivery. Apply suitable impact tape or a removable face marking, hit a small set, and record the actual marks. Try controlled shorter swings to center the pattern before adding speed. Have the player enter heel/center/toe and low/center/high; these are observed inputs, not R10 measurements. Check strike consistency and ball speed at comparable club speed. [PGA strike-location practice](https://www.pga.com/story/x-marks-the-spot-for-consistent-ball-striking-a-lesson-from-xander-schauffele).

**K05 — Conditional grip check for a hook.** Offer only if a strong/underneath trail-hand position is actually observed or reported. Check a more neutral grip with the face aimed at the chosen start line, then use controlled swings to test the result. If the grip is already appropriate, choose another branch. Judge the resulting goal error; abandon an adjustment that creates an unwanted opposite miss. [PGA hook instruction](https://www.pga.com/story/how-to-fix-a-hook-golf-swing).

**K06 — Ball-then-ground contact.** Use for an iron from the ground when turf/strike evidence indicates poor contact. Put a visible line at the ball position, rehearse short swings, and aim for the first ground contact on the target side. Record where contact starts; build toward normal swings gradually. A virtual line cannot detect actual ground contact: obtain player/video evidence. Do not apply this driver-style indiscriminately or infer fat contact just from smash. [PGA low-point practice](https://www.pga.com/story/pga-coach-shares-4-easy-golf-drills-to-improve-your-swing).

**K07 — Driver launch setup.** Use for a driver distance/trajectory goal with a verified low-launch pattern, relevant downward delivery, and checked strike. Review ball position and tee setup; test one small setup change at a time with controlled swings. Track launch, ball speed, spin quality, carry, and the selected dispersion constraint. Do not prescribe the same change for irons or assume every negative driver attack angle is faulty. [Titleist driver setup instruction](https://www.titleist.com/videos/instruction/long-drive-keys-to-distance).

**K08 — Controlled speed ladder.** Use when speed/distance is the chosen goal and contact is sufficiently repeatable. Make a small sequence at increasing comfortable effort, maintaining balance and strike quality. Record ball speed and goal constraints; choose the effort that produces the best sustainable block, not one maximum. Do not prescribe speed work to an isolated short mishit. [PGA speed and consistency practice](https://www.pga.com/story/boost-your-drive-tips-for-increasing-speed-and-consistency-off-the-tee).

**K09 — Trajectory experiment.** Use only with known club, lie, and trajectory intent. For finesse wedges, small setup changes can train different flights; preserve contact and choose the landing target first. For persistent full-swing high/low flight with normal strike, request video or fitting information rather than assert a wrist/release fault. Never extrapolate a short-game technique into a universal full-swing cure. [Titleist finesse trajectory practice](https://www.titleist.com/videos/instruction/adjust-your-setup-to-alter-finesse-shot-trajectory).

A production card should store `id`, `version`, source URL, author/reviewer, club/lie/handedness applicability, prerequisites, contraindications, competing causes, steps, one short cue, expected metric direction, follow-up window, and an exit condition. Mark these starter cards as `reviewStatus: draft`; do not falsely call them expert-validated. Changes to step/rep counts should be versioned with the app policy.

## 5. Supplying context to Gemini

Use the accompanying `ai-coach-system-prompt.md` as the stable instruction layer. Supply the foundation, glossary/units, and a few reviewed example cases. Then provide the current goal state, shot, player context, recent-shot summary, active drill, and applicable cards for each request.

Minimum additional player/session inputs:

- Club identity and preferably actual loft; handedness; stock/partial/punch/shape intent.
- Intended start line and landing target in the calibrated R10/AR frame.
- Current goal, constraints, acceptance band, and aggregation policy.
- Per-club baseline and recent comparable shots; active cue and response to it.
- Mat/grass/tee, indoor/open range/net, ball type, alignment verification, relevant device status, and firmware.
- Field-level availability/provenance; separately known spin magnitude and axis provenance.
- Optional observed impact location, turf contact, or swing video. Do not pretend these exist when omitted.

For an MVP, manually include the small vetted card library in a stable prompt prefix. A list of website links alone is not the context: include your own concise, sourced summaries. Uploading a file does not fine-tune the model. Fine-tuning is not needed to establish the initial golf rules.

As the corpus grows, retrieve a few applicable cards using structured filters for club, intent, miss, and data quality, followed by semantic retrieval if useful. Retrieve competing explanations and diagnostic checks as well as the favorite fix. Google's File Search provides managed retrieval if you want that infrastructure; a small local JSON catalog is sufficient initially. [Google File Search](https://aistudio.google.com/docs/file-search).

Keep shared instructions first and dynamic shots last. Gemini 4 supports implicit caching, not explicit cache objects; do not build around an explicit-cache assumption. Do not add irrelevant content merely to reach a caching threshold. [Google caching](https://aistudio.google.com/docs/caching).

Set a bounded output length and use a JSON Schema with enums for goal status, decision, issue, and card ID. Validate it in application code. Structured output constrains the shape, not the correctness of the golf explanation. Ask for brief evidence-linked rationale, not hidden chain-of-thought. [Google structured outputs](https://aistudio.google.com/docs/structured-output).

### Example coaching request (proposed envelope, not the current bridge protocol)

```json
{
  "contextVersion": "coach-v1",
  "player": { "handedness": "right", "clubId": "driver", "intent": "stock_full" },
  "goal": {
    "id": "speed-140",
    "metric": "median_ball_speed_mph",
    "direction": "increase",
    "target": 140,
    "singleShotEncouragementBand": [138, 143],
    "windowShots": 10
  },
  "goalEvaluation": {
    "status": "collecting",
    "comparableShots": 6,
    "primaryMetricValue": 139.2,
    "shotInEncouragementBand": true,
    "allowedDecision": "praise",
    "allowSwingCorrection": false
  },
  "shot": {
    "shotId": 42,
    "ball": { "speedMph": 141, "launchAngleDeg": 13.2, "launchDirectionDeg": 1.1,
      "backspinRpm": 2600, "sidespinRpm": 120, "spinMeasured": true },
    "club": { "speedMph": 97, "faceAngleDeg": 1.0, "pathAngleDeg": 0.5, "attackAngleDeg": 1.0 }
  },
  "quality": {
    "directionSignsVerified": true,
    "alignmentVerified": true,
    "spinMagnitudeSource": "device_measured",
    "spinAxisSource": "device_calculated",
    "carrySource": "app_simulation"
  },
  "activeDrill": null,
  "applicableCardIds": []
}
```

Expected output should allow a success with no diagnosis:

```json
{
  "shotId": 42,
  "decision": "praise",
  "goalStatus": "collecting",
  "message": "Good job—141 mph is in your ball-speed target. Keep that feel for the next four shots.",
  "observations": [{ "metric": "ball.speedMph", "value": 141, "unit": "mph", "source": "device" }],
  "primaryIssue": null,
  "impactHypotheses": [],
  "selectedCardId": null,
  "cue": null,
  "alternativeCardIds": [],
  "followUp": { "shots": 4, "check": "Complete the 10-shot block before judging sustained speed improvement." },
  "limitations": []
}
```

For a coaching response, require each hypothesis to identify evidence fields, uncertainty/alternatives, and a permitted card. Allow at most one active cue and two separately labeled alternatives, with a condition for when to try each. Compatible setup checks may accompany the main drill; opposed swing changes should never be prescribed together.

Reject or fall back when a response changes application-computed goal status, invents data, uses unavailable card IDs, asserts an unobserved body fault, promises a yardage gain, or diagnoses a curve from unverified signs. Keep source URLs in a server-owned ID map so the model cannot fabricate citations. Deduplicate feedback by session/shot ID and discard stale responses when the goal or club has changed.

For the app, keep the API key outside a shipped Unity client. The current Mac bridge or a backend can own requests. Prototype prompts manually in AI Studio, then call the Gemini API with the same versioned context. No implementation or paid API evaluation has been performed as part of this research.

## 6. Establish that suggestions work

Create a coach-reviewed benchmark before trusting live feedback. A useful initial target is 100–200 diverse cases, including both hands, clubs/lofts, goals, intentional curves, partial shots, missing fields, near-threshold values, and contradictory readings. These counts are proposed starting points, not proof of validity.

Include paired counterexamples:

1. Same delivery, different goal: an accepted speed gain versus a failed dispersion constraint.
2. Same curve direction, opposite path problems: reject one universal slice fix.
3. Low intentional punch versus unintended low stock iron: no automatic `topped` diagnosis.
4. Wedge smash versus driver smash: no universal efficiency threshold.
5. Missing face angle with valid club speed: no fabricated square face.
6. Indoor measured total spin with calculated axis: no independent-axis confidence.
7. Driver curve conflicting with delivery: consider strike/data checks.
8. One centered shot in a wide group: no claim that dispersion is fixed.
9. Tight group off target: distinguish precision from target accuracy.
10. Goal met: praise without a gratuitous correction.
11. Apparent tiny improvement within device/session variation: do not claim success.
12. Real mishits in a practice block: keep them in performance metrics.

Score outcome description, impact plausibility, handling of uncertainty, goal adherence, intervention applicability, conflicting advice, and unsupported body claims. Have coaches identify multiple acceptable interventions where appropriate; one reference answer is often too narrow. Compare Argon and Hydrogen blindly on identical inputs, measuring latency and actual token cost as well as coach ratings. A more expensive model can be a useful comparator, but is not the ground truth.

Then run supervised practice trials: record a comparable baseline, assign one intervention, measure a fresh block, and check retention in a later session. Repeatedly overlapping rolling windows are not independent evidence. Track goal success, strike, and selected constraints; distinguish improvement in a simulator from improvement on a course. Source-backed drills are plausible starting points, not a guarantee of benefit for an individual.

## 7. Suggested build order

1. Verify hardware packet behavior/signs and preserve nullable fields.
2. Add goal/club/intent/target/session context and a deterministic goal evaluator.
3. Export unscaled simulated outcomes with provenance and comparable-shot statistics.
4. Review/version the coaching cards with a qualified coach; prepare paired benchmark cases.
5. Prototype the prompt and JSON response contract in AI Studio; evaluate both models.
6. Integrate backend requests and AR presentation; show one cue and retain it for the practice block.
7. Measure whether the advice improves the chosen goal; expand the library from observed failures.

The most important feature is the feedback loop: **the user's objective defines success, measured evidence constrains the explanation, and subsequent shots determine whether the experiment helped.**
