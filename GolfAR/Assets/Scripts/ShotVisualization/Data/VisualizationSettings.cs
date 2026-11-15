using System;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    public enum Handedness { Right, Left }

    public enum SidespinConvention
    {
        /// <summary>Use |sidespin| for the amount and face-to-path for the direction.
        /// Works no matter which sign convention the pipeline uses. Recommended until it is confirmed.</summary>
        InferFromFaceToPath,
        PositiveCurvesRight,
        PositiveCurvesLeft
    }

    public enum DistanceUnits { Yards, Meters }

    [Serializable]
    public class VisualizationSettings
    {
        [Header("Golfer")]
        public Handedness handedness = Handedness.Right;

        [Header("Data conventions (confirm with the R10 pipeline)")]
        public SidespinConvention sidespinConvention = SidespinConvention.InferFromFaceToPath;
        [Tooltip("Used when face-to-path is too small to tell the curve direction.")]
        public bool sidespinPositiveCurvesRightFallback = true;
        public bool launchDirectionPositiveIsRight = true;

        [Header("Display")]
        public DistanceUnits distanceUnits = DistanceUnits.Yards;
        [Tooltip("1 = real size. 0.05 makes a 200 yd shot fit on a 10 m stretch of room.")]
        [Range(0.01f, 1f)] public float distanceScale = 1f;
        [Tooltip("1 = real time. 2 = the flight plays twice as fast.")]
        [Range(0.25f, 4f)] public float playbackSpeed = 1f;

        /// <summary>Signed sidespin where + means the ball curves right.</summary>
        public float SidespinRightRpm(ShotData shot)
        {
            float s = shot.ball.sidespinRpm;
            switch (sidespinConvention)
            {
                case SidespinConvention.PositiveCurvesRight: return s;
                case SidespinConvention.PositiveCurvesLeft: return -s;
                default:
                    float ftp = shot.FaceToPathDeg;
                    if (shot.HasClubData && Mathf.Abs(ftp) >= 0.25f)
                        return Mathf.Abs(s) * Mathf.Sign(ftp);
                    return sidespinPositiveCurvesRightFallback ? s : -s;
            }
        }

        /// <summary>Launch direction where + means right of target.</summary>
        public float LaunchDirectionRightDeg(ShotData shot)
        {
            return launchDirectionPositiveIsRight ? shot.ball.launchDirectionDeg : -shot.ball.launchDirectionDeg;
        }

        public float ToDisplayDistance(float meters)
        {
            return distanceUnits == DistanceUnits.Yards ? meters * 1.093613f : meters;
        }

        public string DistanceUnitLabel { get { return distanceUnits == DistanceUnits.Yards ? "yd" : "m"; } }
    }
}
