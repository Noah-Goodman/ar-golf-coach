using System.Collections.Generic;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>Result of simulating one ball flight. Positions are local to the tee, in meters:
    /// x = right of target, y = up, z = toward the target.</summary>
    public class FlightResult
    {
        public readonly List<Vector3> points = new List<Vector3>();
        public readonly List<float> times = new List<float>();
        public float carryMeters;      // straight-line distance from tee to landing spot
        public float alongTargetMeters; // distance down the target line
        public float offlineMeters;     // + = right of target
        public float apexMeters;
        public int apexIndex;
        public float hangTimeSeconds;

        public Vector3 Landing { get { return points.Count > 0 ? points[points.Count - 1] : Vector3.zero; } }
        public Vector3 Apex { get { return points.Count > 0 ? points[apexIndex] : Vector3.zero; } }

        /// <summary>Position at time t (seconds), interpolated.</summary>
        public Vector3 PositionAt(float t)
        {
            if (points.Count == 0) return Vector3.zero;
            if (t <= 0f) return points[0];
            if (t >= hangTimeSeconds) return Landing;
            int hi = times.BinarySearch(t);
            if (hi >= 0) return points[hi];
            hi = ~hi;
            int lo = hi - 1;
            float u = Mathf.InverseLerp(times[lo], times[hi], t);
            return Vector3.Lerp(points[lo], points[hi], u);
        }
    }

    /// <summary>
    /// Carry-only ball flight from launch data: gravity, drag and Magnus lift with spin decay.
    /// Constants were fit to TrackMan PGA Tour averages (driver, 7-iron, pitching wedge carry
    /// and apex come out within about 5%). Good enough for coaching visuals, not for club fitting.
    /// If OpenGolfSim hands us its own trajectory, pass those points to the visualizer instead.
    /// </summary>
    public static class BallFlightSimulator
    {
        const float AirDensity = 1.225f;    // kg/m^3
        const float BallRadius = 0.021335f; // m
        const float BallMass = 0.04593f;    // kg
        const float Gravity = 9.81f;
        const float MphToMs = 0.44704f;
        const float RpmToRadS = 2f * Mathf.PI / 60f;

        const float DragBase = 0.21f;
        const float DragPerSpin = 0.30f;   // extra drag per unit of spin factor
        const float LiftScale = 0.45f;     // Cl = LiftScale * S^LiftExponent
        const float LiftExponent = 0.4f;
        const float SpinDecaySeconds = 25f;

        const float Dt = 0.005f;
        const int RecordEvery = 4;          // keep a point every 20 ms
        const float MaxSeconds = 15f;

        /// <param name="sidespinRightRpm">Sidespin with + meaning the ball curves right (see VisualizationSettings).</param>
        /// <param name="launchDirRightDeg">Launch direction with + meaning right of target.</param>
        public static FlightResult Simulate(BallData ball, float sidespinRightRpm, float launchDirRightDeg)
        {
            var result = new FlightResult();
            float speed = ball.speedMph * MphToMs;
            float la = ball.launchAngleDeg * Mathf.Deg2Rad;
            float ld = launchDirRightDeg * Mathf.Deg2Rad;

            Vector3 vel = new Vector3(
                speed * Mathf.Cos(la) * Mathf.Sin(ld),
                speed * Mathf.Sin(la),
                speed * Mathf.Cos(la) * Mathf.Cos(ld));
            Vector3 pos = Vector3.zero;

            // Spin vector: backspin turns about -x (gives lift when moving +z),
            // right-curving sidespin turns about +y (pushes the ball toward +x).
            Vector3 spin0 = new Vector3(-ball.backspinRpm * RpmToRadS, sidespinRightRpm * RpmToRadS, 0f);
            float k = 0.5f * AirDensity * Mathf.PI * BallRadius * BallRadius / BallMass;

            result.points.Add(pos);
            result.times.Add(0f);

            float t = 0f;
            int step = 0;
            while (t < MaxSeconds)
            {
                Vector3 spin = spin0 * Mathf.Exp(-t / SpinDecaySeconds);
                float v = vel.magnitude;
                float s = v > 0.01f ? BallRadius * spin.magnitude / v : 0f;

                float cd = DragBase + DragPerSpin * Mathf.Min(s, 0.5f);
                float cl = s > 0f ? LiftScale * Mathf.Pow(s, LiftExponent) : 0f;

                Vector3 drag = -k * cd * v * vel;
                Vector3 magnusDir = Vector3.Cross(spin, vel);
                Vector3 lift = magnusDir.sqrMagnitude > 1e-8f ? k * cl * v * v * magnusDir.normalized : Vector3.zero;
                Vector3 acc = drag + lift + Vector3.down * Gravity;

                Vector3 prev = pos;
                vel += acc * Dt;
                pos += vel * Dt;
                t += Dt;
                step++;

                if (pos.y < 0f && t > 0.1f)
                {
                    // Interpolate to the exact ground crossing.
                    float u = prev.y / (prev.y - pos.y);
                    pos = Vector3.Lerp(prev, pos, u);
                    pos.y = 0f;
                    t -= Dt * (1f - u);
                    result.points.Add(pos);
                    result.times.Add(t);
                    break;
                }
                if (step % RecordEvery == 0)
                {
                    result.points.Add(pos);
                    result.times.Add(t);
                }
            }

            for (int i = 0; i < result.points.Count; i++)
                if (result.points[i].y > result.points[result.apexIndex].y) result.apexIndex = i;

            Vector3 land = result.Landing;
            result.apexMeters = result.Apex.y;
            result.hangTimeSeconds = result.times[result.times.Count - 1];
            result.alongTargetMeters = land.z;
            result.offlineMeters = land.x;
            result.carryMeters = new Vector2(land.x, land.z).magnitude;
            return result;
        }

        /// <summary>Builds a FlightResult from points someone else computed (for example OpenGolfSim).
        /// Points are local tee space in meters; timeStep is the spacing between them in seconds.</summary>
        public static FlightResult FromPoints(IList<Vector3> localPoints, float timeStep)
        {
            var result = new FlightResult();
            for (int i = 0; i < localPoints.Count; i++)
            {
                result.points.Add(localPoints[i]);
                result.times.Add(i * timeStep);
                if (localPoints[i].y > localPoints[result.apexIndex].y) result.apexIndex = i;
            }
            if (result.points.Count == 0) return result;
            Vector3 land = result.Landing;
            result.apexMeters = result.Apex.y;
            result.hangTimeSeconds = result.times[result.times.Count - 1];
            result.alongTargetMeters = land.z;
            result.offlineMeters = land.x;
            result.carryMeters = new Vector2(land.x, land.z).magnitude;
            return result;
        }
    }
}
