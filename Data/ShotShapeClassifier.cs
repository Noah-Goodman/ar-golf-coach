using UnityEngine;

namespace ArGolfCoach.Visualization
{
    public struct ShotShape
    {
        public string name;          // "Push slice", "Draw", "Straight" ...
        public string startLabel;    // "Push", "Pull" or "" (started on line)
        public string curveLabel;    // "Fade", "Slice", "Draw", "Hook" or "" (no curve)
        public string pathLabel;     // "in-to-out", "out-to-in", "square"
        public string faceLabel;     // "open", "closed", "square" (relative to target)
        public string curveDirection;// "curves right", "curves left", "flies straight"
        public string cue;           // one short external-focus cue for the player
        public bool isMiss;          // slice, hook, or a big push/pull
    }

    /// <summary>
    /// Names a shot from launch direction (where it starts) and face-to-path (how it curves).
    /// Thresholds are simple rules of thumb and easy to tune below.
    /// </summary>
    public static class ShotShapeClassifier
    {
        public const float StartThresholdDeg = 2.0f;   // beyond this the ball starts noticeably off line
        public const float CurveThresholdDeg = 1.0f;   // face-to-path below this barely curves
        public const float BigCurveThresholdDeg = 4.5f;// beyond this a fade becomes a slice
        public const float SquareThresholdDeg = 0.5f;
        public const float LowLaunchDeg = 6.0f;        // below this (any club) the ball was likely topped or thinned
        public const float PoorSmashFactor = 1.15f;    // well below a 7-iron's ~1.33

        public static ShotShape Classify(ShotData shot, VisualizationSettings settings)
        {
            bool rh = settings.handedness == Handedness.Right;
            float startRight = settings.LaunchDirectionRightDeg(shot);
            var s = new ShotShape();

            // Where it starts. For a right-hander, starting right is a push; for a left-hander it is a pull.
            if (Mathf.Abs(startRight) < StartThresholdDeg) s.startLabel = "";
            else s.startLabel = (startRight > 0) == rh ? "Push" : "Pull";

            // How it curves. Face-to-path > 0 curves right for everyone; the name depends on handedness.
            float ftp;
            if (shot.HasClubData) ftp = shot.FaceToPathDeg;
            else ftp = settings.SidespinRightRpm(shot) / 250f; // rough stand-in when only ball data exists

            float mag = Mathf.Abs(ftp);
            bool curvesRight = ftp > 0;
            if (mag < CurveThresholdDeg)
            {
                s.curveLabel = "";
                s.curveDirection = "flies straight";
            }
            else
            {
                bool awayFromBody = curvesRight == rh; // fade/slice side
                if (mag > BigCurveThresholdDeg) s.curveLabel = awayFromBody ? "Slice" : "Hook";
                else s.curveLabel = awayFromBody ? "Fade" : "Draw";
                s.curveDirection = curvesRight ? "curves right" : "curves left";
            }

            if (s.startLabel == "" && s.curveLabel == "") s.name = "Straight";
            else if (s.startLabel == "") s.name = s.curveLabel;
            else if (s.curveLabel == "") s.name = s.startLabel;
            else s.name = s.startLabel + " " + s.curveLabel.ToLowerInvariant();

            // Poor contact overrides the shape name: a topped or thin shot barely gets airborne,
            // and a very low smash factor means the ball came off the toe, heel or ground.
            bool lowLaunch = shot.ball.launchAngleDeg < LowLaunchDeg;
            bool poorSmash = shot.HasClubData && shot.SmashFactor < PoorSmashFactor;
            if (lowLaunch) s.name = "Thin / topped";
            else if (poorSmash) s.name = "Mis-hit";

            // Path and face words, relative to the target line.
            float path = shot.club.pathAngleDeg;
            float face = shot.club.faceAngleDeg;
            if (Mathf.Abs(path) < SquareThresholdDeg) s.pathLabel = "square";
            else s.pathLabel = (path > 0) == rh ? "in-to-out" : "out-to-in";
            if (Mathf.Abs(face) < SquareThresholdDeg) s.faceLabel = "square";
            else s.faceLabel = (face > 0) == rh ? "open" : "closed";

            s.isMiss = s.curveLabel == "Slice" || s.curveLabel == "Hook" || Mathf.Abs(startRight) > 6f || lowLaunch || poorSmash;
            if (lowLaunch) s.cue = "Brush the mat just past where the ball sits";
            else if (poorSmash) s.cue = "Make the ball the first thing the clubface touches";
            else s.cue = CueFor(s, rh);
            return s;
        }

        // Cues name the club or the target, never body parts (external focus of attention, Wulf).
        // "Out" is the side away from the golfer's body: right for a right-hander, left for a left-hander.
        static string CueFor(ShotShape s, bool rh)
        {
            string outSide = rh ? "right" : "left";
            string inSide = rh ? "left" : "right";
            switch (s.curveLabel)
            {
                case "Slice": return "Swing the club out toward the " + outSide + " edge of the gate";
                case "Fade": return "Nice fade. Aim a little " + inSide + " and let it work back";
                case "Hook": return "Keep the clubface pointed at the target longer";
                case "Draw": return "Nice draw. Aim a little " + outSide + " and let it turn back";
            }
            if (s.startLabel == "Push") return "Start the ball at the " + inSide + " edge of your target";
            if (s.startLabel == "Pull") return "Start the ball at the " + outSide + " edge of your target";
            return "On line. Repeat that swing";
        }
    }
}
