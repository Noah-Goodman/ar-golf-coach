using System;
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

        /// <summary>Raised after a shot is processed (before the flight animation ends).</summary>
        public event Action<ShotData, FlightResult, ShotShape> ShotVisualized;

        public ShotData LastShot { get; private set; }
        public FlightResult LastFlight { get; private set; }
        public ShotShape LastShape { get; private set; }

        bool waitingToReveal;

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
        }

        void OnDisable()
        {
            ShotEvents.ShotReceived -= Visualize;
            if (trajectory != null) trajectory.FlightFinished -= OnFlightFinished;
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

            if (ShotVisualized != null) ShotVisualized(shot, flight, shape);
        }

        void OnFlightFinished(FlightResult flight)
        {
            if (!waitingToReveal || LastShot == null) return;
            waitingToReveal = false;
            if (showStatsPanel && statsPanel != null) statsPanel.Show(LastShot, LastFlight, LastShape, settings);
        }

        public void ClearAll()
        {
            if (trajectory != null) trajectory.ClearAll();
            if (clubDelivery != null) clubDelivery.Hide();
            if (statsPanel != null) statsPanel.ShowWaiting("Waiting for a shot…");
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
