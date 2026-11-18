using System;
using System.Collections;
using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// Draws the ball flight: an animated ball with a trail, the flight line drawing itself
    /// behind it, a shadow line on the ground that makes the curve easy to read, a target line,
    /// an apex label, a landing ring with carry and offline, and faded copies of recent shots.
    /// </summary>
    public class TrajectoryVisualizer : MonoBehaviour
    {
        [Header("Materials (optional)")]
        [Tooltip("Vertex-colored transparent unlit material. Leave empty to create one at runtime.")]
        public Material lineMaterial;
        [Tooltip("Optional ball model. A white sphere is used if empty.")]
        public GameObject ballPrefab;
        public TMP_FontAsset font;

        [Header("Look")]
        public Color flightColor = VizColors.Flight;
        public Color shadowColor = VizColors.Shadow;
        public Color targetLineColor = VizColors.Target;
        public Color historyColor = VizColors.History;
        [Tooltip("Width of the flight line at the far end, in meters at real scale.")]
        public float flightLineWidth = 0.35f;
        [Tooltip("Ball size in meters. A real ball is 0.043 m, which is invisible at 100 m, so this is exaggerated.")]
        public float ballDiameter = 0.3f;
        public float trailSeconds = 0.6f;
        public float landingRingRadius = 3f;

        [Header("What to show")]
        public bool showGroundShadow = true;
        public bool showTargetLine = true;
        public bool showApexLabel = true;
        public bool showLandingMarker = true;
        [Tooltip("How many previous shots stay on screen (faded) for a dispersion view.")]
        [Range(0, 20)] public int historyCount = 5;

        /// <summary>Raised when the ball lands.</summary>
        public event Action<FlightResult> FlightFinished;

        public bool IsPlaying { get { return playRoutine != null; } }

        /// <summary>Adds the root object of the current shot and of each faded earlier shot.</summary>
        public void CollectShotRoots(List<GameObject> into)
        {
            if (current != null && current.root != null) into.Add(current.root);
            foreach (ShotVisual v in history) if (v.root != null) into.Add(v.root);
        }

        class ShotVisual
        {
            public GameObject root;
            public LineRenderer flight, shadow, ring;
            public GameObject ball;
            public TextMeshPro apexLabel, landingLabel;
        }

        ShotVisual current;
        readonly Queue<ShotVisual> history = new Queue<ShotVisual>();
        LineRenderer targetLine;
        Coroutine playRoutine;

        Material LineMat { get { return lineMaterial != null ? lineMaterial : VizUtil.DefaultLineMaterial; } }

        /// <summary>Animates one flight. tee.forward is the target line; settings.distanceScale shrinks it.</summary>
        public void Play(FlightResult flight, Pose tee, VisualizationSettings settings, string landingText, string apexText)
        {
            if (flight == null || flight.points.Count < 2) return;
            if (playRoutine != null) { StopCoroutine(playRoutine); playRoutine = null; FinishCurrent(); }
            ArchiveCurrent();

            float scale = settings.distanceScale;
            var world = new List<Vector3>(flight.points.Count);
            foreach (Vector3 p in flight.points) world.Add(tee.position + tee.rotation * (p * scale));

            current = BuildShotVisual(world, tee, scale);
            UpdateTargetLine(tee, Mathf.Max(flight.alongTargetMeters * 1.15f, 40f) * scale);
            playRoutine = StartCoroutine(Animate(flight, world, tee, scale, settings.playbackSpeed, landingText, apexText));
        }

        /// <summary>Removes every shot, including history.</summary>
        public void ClearAll()
        {
            if (playRoutine != null) { StopCoroutine(playRoutine); playRoutine = null; }
            if (current != null) VizUtil.DestroySafe(current.root);
            current = null;
            while (history.Count > 0) VizUtil.DestroySafe(history.Dequeue().root);
        }

        ShotVisual BuildShotVisual(List<Vector3> world, Pose tee, float scale)
        {
            var v = new ShotVisual();
            v.root = new GameObject("Shot Flight");
            v.root.transform.SetParent(transform, false);

            v.flight = VizUtil.CreateLine("Flight Line", v.root.transform, LineMat, flightColor, 1f);
            v.flight.widthMultiplier = flightLineWidth * Mathf.Max(scale, 0.05f);
            v.flight.widthCurve = AnimationCurve.Linear(0f, 0.15f, 1f, 1f); // thin at the tee, wider far away

            if (showGroundShadow)
            {
                v.shadow = VizUtil.CreateLine("Ground Shadow", v.root.transform, LineMat, shadowColor, 1f);
                v.shadow.widthMultiplier = flightLineWidth * 0.8f * Mathf.Max(scale, 0.05f);
                v.shadow.widthCurve = AnimationCurve.Linear(0f, 0.15f, 1f, 1f);
                v.shadow.alignment = LineAlignment.TransformZ; // lie flat on the ground
                v.shadow.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
            }

            v.ball = ballPrefab != null ? Instantiate(ballPrefab, v.root.transform) : CreateDefaultBall(v.root.transform);
            v.ball.transform.position = world[0];
            v.ball.transform.localScale = Vector3.one * ballDiameter * Mathf.Max(scale, 0.1f);

            var trail = v.ball.GetComponent<TrailRenderer>();
            if (trail == null) trail = v.ball.AddComponent<TrailRenderer>();
            trail.material = LineMat;
            trail.time = trailSeconds;
            trail.minVertexDistance = 0.05f;
            trail.widthMultiplier = ballDiameter * Mathf.Max(scale, 0.1f);
            trail.widthCurve = AnimationCurve.Linear(0f, 1f, 1f, 0f);
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(flightColor, 1f) },
                new[] { new GradientAlphaKey(0.9f, 0f), new GradientAlphaKey(0f, 1f) });
            trail.colorGradient = g;
            trail.Clear();
            return v;
        }

        GameObject CreateDefaultBall(Transform parent)
        {
            var ball = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            ball.name = "Ball";
            var col = ball.GetComponent<Collider>();
            if (col != null) VizUtil.DestroySafe(col);
            ball.transform.SetParent(parent, false);
            var r = ball.GetComponent<Renderer>();
            if (r != null) r.material.color = Color.white;
            return ball;
        }

        IEnumerator Animate(FlightResult flight, List<Vector3> world, Pose tee, float scale, float speed,
                            string landingText, string apexText)
        {
            var drawn = new List<Vector3>(world.Count);
            var shadowPts = new List<Vector3>(world.Count);
            float t = 0f;
            int next = 0;
            bool apexShown = false;

            while (t < flight.hangTimeSeconds)
            {
                t += Time.deltaTime * speed;
                while (next < world.Count && flight.times[next] <= t)
                {
                    drawn.Add(world[next]);
                    shadowPts.Add(Ground(world[next], tee));
                    next++;
                }
                Vector3 ballPos = tee.position + tee.rotation * (flight.PositionAt(t) * scale);
                current.ball.transform.position = ballPos;

                // Lines end exactly at the ball.
                drawn.Add(ballPos);
                VizUtil.SetPositions(current.flight, drawn);
                drawn.RemoveAt(drawn.Count - 1);
                if (current.shadow != null)
                {
                    shadowPts.Add(Ground(ballPos, tee));
                    VizUtil.SetPositions(current.shadow, shadowPts);
                    shadowPts.RemoveAt(shadowPts.Count - 1);
                }

                if (!apexShown && showApexLabel && next > flight.apexIndex)
                {
                    apexShown = true;
                    current.apexLabel = VizUtil.CreateLabel("Apex Label", current.root.transform, VizColors.Text, 0.2f, font);
                    current.apexLabel.text = apexText;
                    current.apexLabel.transform.position = world[flight.apexIndex] + Vector3.up * (2f * scale + 0.1f);
                }
                yield return null;
            }

            VizUtil.SetPositions(current.flight, world);
            if (current.shadow != null)
            {
                shadowPts.Clear();
                foreach (Vector3 p in world) shadowPts.Add(Ground(p, tee));
                VizUtil.SetPositions(current.shadow, shadowPts);
            }
            current.ball.transform.position = world[world.Count - 1];

            if (showLandingMarker)
            {
                Vector3 land = Ground(world[world.Count - 1], tee);
                current.ring = VizUtil.CreateLine("Landing Ring", current.root.transform, LineMat, flightColor, 0.15f * Mathf.Max(scale, 0.1f));
                VizUtil.SetCircle(current.ring, land, tee.rotation, landingRingRadius * Mathf.Max(scale, 0.05f));
                current.landingLabel = VizUtil.CreateLabel("Landing Label", current.root.transform, VizColors.Text, 0.22f, font);
                current.landingLabel.text = landingText;
                current.landingLabel.transform.position = land + Vector3.up * (4f * scale + 0.15f);
            }

            playRoutine = null;
            if (FlightFinished != null) FlightFinished(flight);
        }

        // Shadow sits just above the tee's ground plane.
        static Vector3 Ground(Vector3 worldPoint, Pose tee)
        {
            return new Vector3(worldPoint.x, tee.position.y + 0.01f, worldPoint.z);
        }

        void FinishCurrent()
        {
            // A new shot arrived mid-flight: snap the old one to its final state before archiving.
            if (current == null) return;
            if (current.flight.positionCount > 0 && current.ball != null)
                current.ball.transform.position = current.flight.GetPosition(current.flight.positionCount - 1);
        }

        void ArchiveCurrent()
        {
            if (current == null) return;
            if (historyCount <= 0) { VizUtil.DestroySafe(current.root); current = null; return; }

            VizUtil.SetColor(current.flight, historyColor);
            current.flight.widthMultiplier *= 0.5f;
            if (current.shadow != null) VizUtil.DestroySafe(current.shadow.gameObject);
            if (current.ball != null) VizUtil.DestroySafe(current.ball);
            if (current.apexLabel != null) VizUtil.DestroySafe(current.apexLabel.gameObject);
            if (current.landingLabel != null) VizUtil.DestroySafe(current.landingLabel.gameObject);
            if (current.ring != null) VizUtil.SetColor(current.ring, historyColor);

            history.Enqueue(current);
            current = null;
            while (history.Count > historyCount) VizUtil.DestroySafe(history.Dequeue().root);
        }

        void UpdateTargetLine(Pose tee, float length)
        {
            if (!showTargetLine)
            {
                if (targetLine != null) targetLine.gameObject.SetActive(false);
                return;
            }
            if (targetLine == null)
                targetLine = VizUtil.CreateLine("Target Line", transform, LineMat, targetLineColor, 0.03f);
            targetLine.gameObject.SetActive(true);
            Vector3 a = tee.position + Vector3.up * 0.005f;
            targetLine.positionCount = 2;
            targetLine.SetPosition(0, a);
            targetLine.SetPosition(1, a + tee.rotation * Vector3.forward * length);
        }
    }
}
