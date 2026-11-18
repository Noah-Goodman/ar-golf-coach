using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// A top-down impact diagram drawn flat on the ground at the ball:
    ///   white line  = target line
    ///   blue arrow  = club path (where the club head was moving)
    ///   orange bar  = clubface, with a thin orange arrow showing where it pointed
    ///   arc + label = face-to-path, which decides which way the ball curves
    /// Real angles are often 1-3 degrees, too small to see, so they are exaggerated
    /// (x3 by default) and the diagram says so.
    /// </summary>
    public class ClubDeliveryVisualizer : MonoBehaviour
    {
        [Header("Materials (optional)")]
        public Material lineMaterial;
        public TMP_FontAsset font;

        [Header("Layout")]
        [Tooltip("Length of the path arrow in meters.")]
        public float arrowLength = 0.8f;
        [Tooltip("Width of the clubface bar in meters.")]
        public float faceWidth = 0.22f;
        [Tooltip("Angles are multiplied by this so small differences are visible. 1 = true angles.")]
        [Range(1f, 6f)] public float angleExaggeration = 3f;
        [Tooltip("Shift the diagram away from the real ball, in tee space (x right, z toward target).")]
        public Vector3 offsetFromBall = Vector3.zero;
        public float heightAboveGround = 0.012f;
        public bool showLabels = true;
        [Tooltip("Label size; smaller than the flight labels because the player is close.")]
        public float labelSizePerMeter = 0.12f;

        [Header("Colors")]
        public Color pathColor = VizColors.Path;
        public Color faceColor = VizColors.Face;
        public Color targetColor = VizColors.Target;
        public Color arcColor = VizColors.Text;

        GameObject root;

        /// <summary>The diagram's root object; null until the first shot.</summary>
        public GameObject Root { get { return root; } }
        readonly List<LineRenderer> lines = new List<LineRenderer>();
        readonly List<TextMeshPro> labels = new List<TextMeshPro>();
        int lineCursor, labelCursor;

        Material LineMat { get { return lineMaterial != null ? lineMaterial : VizUtil.DefaultLineMaterial; } }

        public void Show(ShotData shot, ShotShape shape, Pose tee, VisualizationSettings settings)
        {
            EnsureRoot();
            root.SetActive(true);
            lineCursor = 0;
            labelCursor = 0;

            Vector3 origin = tee.position + tee.rotation * offsetFromBall + Vector3.up * heightAboveGround;
            Quaternion rot = tee.rotation;

            if (!shot.HasClubData)
            {
                HideUnused();
                Label(origin + Vector3.up * 0.15f, "No club data for this shot", VizColors.TextMuted);
                return;
            }

            float path = shot.club.pathAngleDeg;
            float face = shot.club.faceAngleDeg;
            float ftp = shot.FaceToPathDeg;
            float ex = angleExaggeration;

            // Target line through the ball.
            Segment(origin + rot * new Vector3(0f, 0f, -0.45f * arrowLength),
                    origin + rot * new Vector3(0f, 0f, 1.15f * arrowLength), targetColor, 0.008f);

            // Club path: a line through the ball with an arrowhead at the front.
            Vector3 pathDir = rot * Dir(path * ex);
            Vector3 pathTip = origin + pathDir * arrowLength;
            Segment(origin - pathDir * 0.45f * arrowLength, pathTip, pathColor, 0.018f);
            ArrowHead(pathTip, pathDir, pathColor, 0.09f, 0.018f);

            // Clubface: a bar perpendicular to where the face points, plus a thinner aim arrow.
            Vector3 faceDir = rot * Dir(face * ex);
            Vector3 faceAcross = Vector3.Cross(Vector3.up, faceDir).normalized;
            Vector3 faceCenter = origin - faceDir * 0.06f; // just behind the ball
            Segment(faceCenter - faceAcross * faceWidth * 0.5f, faceCenter + faceAcross * faceWidth * 0.5f, faceColor, 0.035f);
            Vector3 faceTip = origin + faceDir * arrowLength * 0.8f;
            Segment(origin, faceTip, faceColor, 0.01f);
            ArrowHead(faceTip, faceDir, faceColor, 0.07f, 0.01f);

            // Arc from path to face: the face-to-path gap that makes the ball curve.
            if (Mathf.Abs(ftp) >= 0.25f) Arc(origin, rot, path * ex, face * ex, arrowLength * 0.55f, arcColor, 0.008f);

            HideUnused();

            if (!showLabels) return;
            string pathWord = shape.pathLabel == "square" ? "square" : Mathf.Abs(path).ToString("0.0") + "° " + shape.pathLabel;
            string faceWord = shape.faceLabel == "square" ? "square" : Mathf.Abs(face).ToString("0.0") + "° " + shape.faceLabel;
            Label(pathTip + pathDir * 0.12f + Vector3.up * 0.05f, "Path " + pathWord, pathColor);
            Label(faceTip + faceDir * 0.1f + Vector3.up * 0.13f, "Face " + faceWord, faceColor);

            Vector3 arcMid = origin + rot * Dir((path + face) * 0.5f * ex) * arrowLength * 0.55f;
            Vector3 sideways = rot * Vector3.right * (ftp >= 0 ? 0.28f : -0.28f);
            Label(arcMid + sideways + Vector3.up * 0.05f,
                  "Face to path " + ftp.ToString("+0.0;-0.0;0.0") + "°\n<size=80%>" + shape.curveDirection + "</size>", arcColor);
            if (ex > 1.01f)
                Label(origin + rot * new Vector3(0f, 0f, -0.6f * arrowLength) + Vector3.up * 0.03f,
                      "<size=70%>angles shown ×" + ex.ToString("0.#") + "</size>", VizColors.TextMuted);
        }

        public void Hide()
        {
            if (root != null) root.SetActive(false);
        }

        // Direction on the ground for an angle measured from the target line, + = right.
        static Vector3 Dir(float deg)
        {
            float r = deg * Mathf.Deg2Rad;
            return new Vector3(Mathf.Sin(r), 0f, Mathf.Cos(r));
        }

        void EnsureRoot()
        {
            if (root != null) return;
            root = new GameObject("Club Delivery Diagram");
            root.transform.SetParent(transform, false);
        }

        LineRenderer NextLine(Color color, float width)
        {
            LineRenderer lr;
            if (lineCursor < lines.Count) lr = lines[lineCursor];
            else
            {
                lr = VizUtil.CreateLine("Diagram Line " + lineCursor, root.transform, LineMat, color, width);
                lr.alignment = LineAlignment.TransformZ; // flat on the ground
                lr.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
                lines.Add(lr);
            }
            lineCursor++;
            lr.gameObject.SetActive(true);
            lr.loop = false;
            VizUtil.SetColor(lr, color);
            lr.startWidth = width;
            lr.endWidth = width;
            return lr;
        }

        void Segment(Vector3 a, Vector3 b, Color color, float width)
        {
            var lr = NextLine(color, width);
            lr.positionCount = 2;
            lr.SetPosition(0, a);
            lr.SetPosition(1, b);
        }

        void ArrowHead(Vector3 tip, Vector3 dir, Color color, float size, float width)
        {
            Vector3 back = -dir.normalized * size;
            Vector3 side = Vector3.Cross(Vector3.up, dir).normalized * size * 0.6f;
            var lr = NextLine(color, width);
            lr.positionCount = 3;
            lr.SetPosition(0, tip + back + side);
            lr.SetPosition(1, tip);
            lr.SetPosition(2, tip + back - side);
        }

        void Arc(Vector3 center, Quaternion rot, float fromDeg, float toDeg, float radius, Color color, float width)
        {
            int n = Mathf.Clamp(Mathf.CeilToInt(Mathf.Abs(toDeg - fromDeg) / 2f), 3, 40);
            var lr = NextLine(color, width);
            lr.positionCount = n + 1;
            for (int i = 0; i <= n; i++)
            {
                float a = Mathf.Lerp(fromDeg, toDeg, i / (float)n);
                lr.SetPosition(i, center + rot * Dir(a) * radius);
            }
        }

        void Label(Vector3 pos, string text, Color color)
        {
            TextMeshPro t;
            if (labelCursor < labels.Count) t = labels[labelCursor];
            else
            {
                t = VizUtil.CreateLabel("Diagram Label " + labelCursor, root.transform, color, labelSizePerMeter, font);
                labels.Add(t);
            }
            labelCursor++;
            t.gameObject.SetActive(true);
            t.color = color;
            t.text = text;
            t.transform.position = pos;
        }

        void HideUnused()
        {
            for (int i = lineCursor; i < lines.Count; i++) lines[i].gameObject.SetActive(false);
            for (int i = labelCursor; i < labels.Count; i++) labels[i].gameObject.SetActive(false);
        }
    }
}
