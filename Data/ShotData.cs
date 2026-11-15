using System;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// One shot message from the launch-monitor pipeline (Garmin R10 -> OpenGolfSim -> Unity).
    /// Field names match the JSON exactly so JsonUtility can parse it with no extra code.
    ///
    /// Sign conventions this code assumes (confirm with the data pipeline):
    ///   launchDirectionDeg  + = ball starts right of the target line
    ///   faceAngleDeg        + = face pointing right of target (open for a right-hander)
    ///   pathAngleDeg        + = club moving right of target (in-to-out for a right-hander)
    ///   attackAngleDeg      + = hitting up, - = hitting down
    ///   sidespinRpm         sign is configurable in VisualizationSettings (see README)
    /// </summary>
    [Serializable]
    public class ShotData
    {
        public string type;
        public int shotId;
        public long receivedAt;   // Unix time in milliseconds
        public BallData ball = new BallData();
        public ClubData club = new ClubData();

        /// <summary>Parses one JSON message. Returns null if it is not a usable shot.</summary>
        public static ShotData FromJson(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            ShotData shot;
            try
            {
                shot = JsonUtility.FromJson<ShotData>(json);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[ShotData] Could not parse shot JSON: " + e.Message);
                return null;
            }
            if (shot == null) return null;
            if (!string.IsNullOrEmpty(shot.type) && shot.type != "shot") return null; // heartbeats etc.
            if (shot.ball == null || shot.ball.speedMph <= 0f)
            {
                Debug.LogWarning("[ShotData] Shot " + shot.shotId + " has no ball speed, ignoring it.");
                return null;
            }
            if (shot.club == null) shot.club = new ClubData();
            return shot;
        }

        public string ToJson(bool pretty = true) { return JsonUtility.ToJson(this, pretty); }

        /// <summary>JsonUtility fills a missing "club" object with zeros, so treat zero club speed as "no club data".</summary>
        public bool HasClubData { get { return club != null && club.speedMph > 0.1f; } }

        /// <summary>Ball speed divided by club speed. 0 if there is no club data.</summary>
        public float SmashFactor { get { return HasClubData ? ball.speedMph / club.speedMph : 0f; } }

        /// <summary>Face angle minus path angle. Positive means the ball curves right, for either handedness.</summary>
        public float FaceToPathDeg { get { return club.faceAngleDeg - club.pathAngleDeg; } }
    }

    [Serializable]
    public class BallData
    {
        public float speedMph;
        public float launchAngleDeg;
        public float launchDirectionDeg;
        public float backspinRpm;
        public float sidespinRpm;
        public bool spinMeasured;

        public float TotalSpinRpm
        {
            get { return Mathf.Sqrt(backspinRpm * backspinRpm + sidespinRpm * sidespinRpm); }
        }
    }

    [Serializable]
    public class ClubData
    {
        public float speedMph;
        public float faceAngleDeg;
        public float pathAngleDeg;
        public float attackAngleDeg;
    }
}
