using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// The one component to put in the scene. It listens for shots (ShotEvents), simulates the
    /// flight, and drives the three visuals: trajectory, impact diagram and stats card.
    ///
    /// Tee Origin: the transform at the real ball's position, with its forward (blue) axis
    /// pointing at the target. Whoever anchors the ball in AR owns that transform; drag it in here.
    /// </summary>
    public class ShotVisualizationController : MonoBehaviour
    {
        [Tooltip("Sits on the real ball; forward = target line. Uses this object if empty.")]
        public Transform teeOrigin;
        public VisualizationSettings settings = new VisualizationSettings();

        [Header("Visuals (created on this object if left empty)")]
        public TrajectoryVisualizer trajectory;
        public ClubDeliveryVisualizer clubDelivery;
        public ShotStatsPanel statsPanel;

        [Header("Behaviour")]
        public bool listenToShotEvents = true;
        [Tooltip("Hold the stats until the ball lands, so the player can guess the result first.")]
        public bool revealStatsAfterLanding = false;
        public bool showClubDiagram = true;
        public bool showStatsPanel = true;
        [Tooltip("Seconds after the ball lands before the flight lines and impact diagram fade out. 0 keeps them.")]
        public float hideLinesAfterSeconds = 10f;
        public float lineFadeSeconds = 1f;

        /// <summary>Raised after a shot is processed (before the flight animation ends).</summary>
        public event Action<ShotData, FlightResult, ShotShape> ShotVisualized;

        public ShotData LastShot { get; private set; }
        public FlightResult LastFlight { get; private set; }
        public ShotShape LastShape { get; private set; }

        bool waitingToReveal;

        // Auto: visible, fading after the next landing. Hidden: faded out or fading.
        // Shown: brought back with the button, staying until it is pressed again.
        enum LinesMode { Auto, Hidden, Shown }
        LinesMode linesMode = LinesMode.Auto;
        Coroutine hideRoutine;
        VisualFade fade;
        readonly List<GameObject> lineRoots = new List<GameObject>();

        void Awake()
        {
            if (teeOrigin == null) teeOrigin = transform;
            if (trajectory == null) trajectory = GetComponentInChildren<TrajectoryVisualizer>();
            if (trajectory == null) trajectory = gameObject.AddComponent<TrajectoryVisualizer>();
            if (clubDelivery == null) clubDelivery = GetComponentInChildren<ClubDeliveryVisualizer>();
            if (clubDelivery == null) clubDelivery = gameObject.AddComponent<ClubDeliveryVisualizer>();
            if (statsPanel == null) statsPanel = GetComponentInChildren<ShotStatsPanel>();
            if (statsPanel == null) statsPanel = gameObject.AddComponent<ShotStatsPanel>();
        }

        void OnEnable()
        {
            if (listenToShotEvents) ShotEvents.ShotReceived += Visualize;
            if (trajectory != null) trajectory.FlightFinished += OnFlightFinished;
            if (statsPanel != null) statsPanel.LinesButtonPressed += ToggleLines;
        }

        void OnDisable()
        {
            ShotEvents.ShotReceived -= Visualize;
            if (trajectory != null) trajectory.FlightFinished -= OnFlightFinished;
            if (statsPanel != null) statsPanel.LinesButtonPressed -= ToggleLines;
        }

        void Update()
        {
            if (statsPanel != null) statsPanel.SetTee(TeePose());
        }

        /// <summary>Visualize a shot using the built-in flight model.</summary>
        public void Visualize(ShotData shot) { Visualize(shot, null); }

        /// <summary>Visualize a shot. Pass a precomputed flight (for example from OpenGolfSim's
        /// trajectory via BallFlightSimulator.FromPoints) to skip the built-in model.</summary>
        public void Visualize(ShotData shot, FlightResult precomputedFlight)
        {
            if (shot == null) return;
            Pose tee = TeePose();

            FlightResult flight = precomputedFlight ?? BallFlightSimulator.Simulate(
                shot.ball, settings.SidespinRightRpm(shot), settings.LaunchDirectionRightDeg(shot));
            ShotShape shape = ShotShapeClassifier.Classify(shot, settings);

            LastShot = shot;
            LastFlight = flight;
            LastShape = shape;

            // A new shot starts the cycle fresh. Lines already hidden stay hidden; a fade in progress finishes at once.
            StopLineFade(true);
            linesMode = LinesMode.Auto;

            if (showClubDiagram && clubDelivery != null) clubDelivery.Show(shot, shape, tee, settings);
            else if (clubDelivery != null) clubDelivery.Hide();

            if (showStatsPanel && statsPanel != null)
            {
                statsPanel.SetTee(tee);
                if (revealStatsAfterLanding)
                {
                    waitingToReveal = true;
                    statsPanel.ShowWaiting("Where will it land?");
                }
                else statsPanel.Show(shot, flight, shape, settings);
            }

            if (trajectory != null)
            {
                string u = " " + settings.DistanceUnitLabel;
                float off = settings.ToDisplayDistance(flight.offlineMeters);
                string offText = Mathf.Abs(off) < 0.5f ? "on line" : Mathf.Abs(off).ToString("0") + u + (off > 0 ? " right" : " left");
                string landing = "<b>" + settings.ToDisplayDistance(flight.carryMeters).ToString("0") + u + "</b>\n<size=70%>" + offText + "</size>";
                string apex = "<size=80%>Apex " + settings.ToDisplayDistance(flight.apexMeters).ToString("0") + u + "</size>";
                trajectory.Play(flight, tee, settings, landing, apex);
            }

            UpdateLinesButton();
            if (ShotVisualized != null) ShotVisualized(shot, flight, shape);
        }

        void OnFlightFinished(FlightResult flight)
        {
            if (linesMode == LinesMode.Auto && hideLinesAfterSeconds > 0f)
                hideRoutine = StartCoroutine(FadeLinesOut(hideLinesAfterSeconds));

            if (!waitingToReveal || LastShot == null) return;
            waitingToReveal = false;
            if (showStatsPanel && statsPanel != null) statsPanel.Show(LastShot, LastFlight, LastShape, settings);
        }

        public void ClearAll()
        {
            StopLineFade(false);
            linesMode = LinesMode.Auto;
            if (trajectory != null) trajectory.ClearAll();
            if (clubDelivery != null) clubDelivery.Hide();
            if (statsPanel != null)
            {
                statsPanel.ShowWaiting("Waiting for a shot…");
                statsPanel.SetLinesButton(false, "");
            }
        }

        /// <summary>The stats card button: hides the lines if any are showing, otherwise brings
        /// back the last shot and the faded earlier ones until pressed again.</summary>
        public void ToggleLines()
        {
            if (LastShot == null) return;
            if (linesMode == LinesMode.Hidden)
            {
                StopLineFade(false);
                CollectLineRoots();
                foreach (GameObject root in lineRoots) root.SetActive(true);
                linesMode = LinesMode.Shown;
            }
            else
            {
                StopLineFade(false);
                hideRoutine = StartCoroutine(FadeLinesOut(0f));
            }
            UpdateLinesButton();
        }

        IEnumerator FadeLinesOut(float delay)
        {
            if (delay > 0f) yield return new WaitForSeconds(delay);
            linesMode = LinesMode.Hidden;
            UpdateLinesButton();
            CollectLineRoots();
            fade = new VisualFade(lineRoots);
            for (float t = 0f; t < lineFadeSeconds; t += Time.deltaTime)
            {
                fade.Apply(1f - t / lineFadeSeconds);
                yield return null;
            }
            fade.Restore();
            fade = null;
            foreach (GameObject root in lineRoots) if (root != null) root.SetActive(false);
            hideRoutine = null;
        }

        // Cancels a pending or running fade. A running fade is undone, then either finished
        // at once (hide) or left visible.
        void StopLineFade(bool hide)
        {
            if (hideRoutine != null) StopCoroutine(hideRoutine);
            hideRoutine = null;
            if (fade == null) return;
            fade.Restore();
            fade = null;
            if (hide) foreach (GameObject root in lineRoots) if (root != null) root.SetActive(false);
        }

        void CollectLineRoots()
        {
            lineRoots.Clear();
            if (trajectory != null) trajectory.CollectShotRoots(lineRoots);
            if (showClubDiagram && clubDelivery != null && clubDelivery.Root != null) lineRoots.Add(clubDelivery.Root);
        }

        void UpdateLinesButton()
        {
            if (statsPanel == null) return;
            statsPanel.SetLinesButton(LastShot != null, linesMode == LinesMode.Hidden ? "Show lines" : "Hide lines");
        }

        /// <summary>Ball position with a yaw-only rotation, so a tilted anchor never tilts the flight.</summary>
        public Pose TeePose()
        {
            Transform t = teeOrigin != null ? teeOrigin : transform;
            Vector3 fwd = Vector3.ProjectOnPlane(t.forward, Vector3.up);
            if (fwd.sqrMagnitude < 1e-4f) fwd = Vector3.forward;
            return new Pose(t.position, Quaternion.LookRotation(fwd.normalized, Vector3.up));
        }

        void OnDrawGizmos()
        {
            Pose p = TeePose();
            Gizmos.color = Color.white;
            Gizmos.DrawWireSphere(p.position, 0.0215f);
            Gizmos.color = Color.cyan;
            Gizmos.DrawLine(p.position, p.position + p.rotation * Vector3.forward * 2f);
        }
    }
}
