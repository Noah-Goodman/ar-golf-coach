using System;
using System.Text;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// A world-space stats card: shot name, ball numbers, club numbers, simulated result,
    /// and one coaching cue. It builds its own Canvas, so you only need to add the component.
    /// Face and path rows use the same orange and blue as the impact diagram.
    /// </summary>
    public class ShotStatsPanel : MonoBehaviour
    {
        public enum Placement { NearTee, FollowHead, ViewCorner, InRoom }

        [Header("Placement")]
        public Placement placement = Placement.NearTee;
        [Tooltip("Where the card sits relative to the ball (x right, y up, z toward target), in meters.")]
        public Vector3 offsetFromTee = new Vector3(1.4f, 1.35f, 1.2f);
        [Tooltip("FollowHead: distance in front of the headset.")]
        public float followDistance = 1.3f;
        [Tooltip("FollowHead: offset in view space (x right, y up). Keeps the card out of the way of the ball.")]
        public Vector2 followViewOffset = new Vector2(0.55f, -0.05f);
        public float followSmoothing = 3f;
        [Tooltip("ViewCorner: head-locked HUD. x right, y up, z forward from the eyes, in meters.")]
        public Vector3 cornerOffset = new Vector3(0.38f, 0.2f, 1f);
        public float cornerSmoothing = 15f;
        [Tooltip("InRoom: where the card appears at launch, from the eyes (x right, y up, z forward), in meters. " +
                 "It then stays put in the room; grab the bar under it to move it.")]
        public Vector3 roomOffset = new Vector3(0.25f, 0f, 1.3f);
        public bool faceThePlayer = true;

        [Header("Look")]
        public TMP_FontAsset font;
        public Vector2 sizePixels = new Vector2(560f, 1100f);
        [Tooltip("World size of one canvas pixel. 0.001 = 1 mm. 0.0009 makes the card about 0.5 x 1 m.")]
        public float metersPerPixel = 0.0009f;
        public Color backgroundColor = VizColors.Panel;
        public bool showCue = true;

        Canvas canvas;
        RectTransform canvasRect;
        TextMeshProUGUI header, labelsColumn, valuesColumn, footer;
        RectTransform linesButton;
        Image linesButtonBg;
        TextMeshProUGUI linesButtonLabel;

        static readonly Color ButtonColor = new Color(1f, 1f, 1f, 0.10f);
        static readonly Color ButtonHoverColor = new Color(1f, 1f, 1f, 0.28f);

        /// <summary>The Show/Hide lines button was pressed (BallPlacer calls PressLinesButton).</summary>
        public event Action LinesButtonPressed;
        Pose tee = new Pose(Vector3.zero, Quaternion.identity);
        bool hasTee;
        float pulse;

        /// <summary>The card itself (the canvas), for placing things beside it.</summary>
        public RectTransform Card { get { Build(); return canvasRect; } }
        /// <summary>InRoom: true once the card has been put in front of the player.</summary>
        public bool Spawned { get; private set; }

        void Awake() { Build(); }

        public void SetTee(Pose teePose) { tee = teePose; hasTee = true; }

        public void ShowWaiting(string message)
        {
            Build();
            canvas.gameObject.SetActive(true);
            header.text = "<size=70%><color=" + VizColors.ToHex(VizColors.TextMuted) + ">SWINGLAB</color></size>\n" + message;
            labelsColumn.text = "";
            valuesColumn.text = "";
            footer.text = "";
        }

        public void Show(ShotData shot, FlightResult flight, ShotShape shape, VisualizationSettings s)
        {
            Build();
            canvas.gameObject.SetActive(true);
            string muted = VizColors.ToHex(VizColors.TextMuted);
            string accent = VizColors.ToHex(shape.isMiss ? VizColors.Miss : VizColors.Good);
            string faceHex = VizColors.ToHex(VizColors.Face);
            string pathHex = VizColors.ToHex(VizColors.Path);

            header.text = "<size=60%><color=" + muted + ">SHOT " + shot.shotId + "</color></size>\n" +
                          "<color=" + accent + "><b>" + shape.name + "</b></color>";

            var L = new StringBuilder();
            var V = new StringBuilder();
            Section(L, V, "BALL", muted);
            Row(L, V, "Ball speed", shot.ball.speedMph.ToString("0.0") + " mph");
            Row(L, V, "Launch angle", shot.ball.launchAngleDeg.ToString("0.0") + "°");
            Row(L, V, "Launch direction", Side(s.LaunchDirectionRightDeg(shot), "°"));
            string est = shot.ball.spinMeasured ? "" : " <color=" + muted + "><size=75%>est.</size></color>";
            Row(L, V, "Backspin", shot.ball.backspinRpm.ToString("#,0") + " rpm" + est);
            float sideRight = s.SidespinRightRpm(shot);
            Row(L, V, "Sidespin", Side(sideRight, " rpm", "0") + est);
            float axis = Mathf.Atan2(sideRight, Mathf.Max(1f, shot.ball.backspinRpm)) * Mathf.Rad2Deg;
            Row(L, V, "Spin axis", Side(axis, "°"));

            if (shot.HasClubData)
            {
                Section(L, V, "CLUB", muted);
                Row(L, V, "Club speed", shot.club.speedMph.ToString("0.0") + " mph");
                Row(L, V, "Smash factor", shot.SmashFactor.ToString("0.00"));
                Row(L, V, "<color=" + faceHex + ">Face</color>",
                    "<color=" + faceHex + ">" + Angle(shot.club.faceAngleDeg, shape.faceLabel) + "</color>");
                Row(L, V, "<color=" + pathHex + ">Path</color>",
                    "<color=" + pathHex + ">" + Angle(shot.club.pathAngleDeg, shape.pathLabel) + "</color>");
                Row(L, V, "Face to path", shot.FaceToPathDeg.ToString("+0.0;-0.0;0.0") + "°");
                float aoa = shot.club.attackAngleDeg;
                Row(L, V, "Attack angle", Mathf.Abs(aoa).ToString("0.0") + "° " + (aoa < 0 ? "down" : aoa > 0 ? "up" : "level"));
            }

            if (flight != null)
            {
                string u = " " + s.DistanceUnitLabel;
                Section(L, V, "RESULT <size=70%>(simulated)</size>", muted);
                Row(L, V, "Carry", s.ToDisplayDistance(flight.carryMeters).ToString("0") + u);
                Row(L, V, "Offline", Side(s.ToDisplayDistance(flight.offlineMeters), u));
                Row(L, V, "Apex height", s.ToDisplayDistance(flight.apexMeters).ToString("0") + u);
                Row(L, V, "Hang time", flight.hangTimeSeconds.ToString("0.0") + " s");
            }

            labelsColumn.text = L.ToString();
            valuesColumn.text = V.ToString();

            var f = new StringBuilder();
            if (showCue && !string.IsNullOrEmpty(shape.cue)) f.Append("<b>Try:</b> ").Append(shape.cue);
            if (!shot.ball.spinMeasured)
                f.Append("\n<size=75%><color=" + muted + ">Spin estimated by the launch monitor</color></size>");
            footer.text = f.ToString();
            pulse = 1f;
        }

        public void Hide() { if (canvas != null) canvas.gameObject.SetActive(false); }

        /// <summary>Shows the top-right button with this label, or hides it.</summary>
        public void SetLinesButton(bool visible, string label)
        {
            Build();
            linesButton.gameObject.SetActive(visible);
            linesButtonLabel.text = label;
        }

        public bool LinesButtonAt(Vector3 worldPoint)
        {
            return linesButton != null && linesButton.gameObject.activeInHierarchy && GrabHandle.Contains(linesButton, worldPoint);
        }

        public void SetLinesButtonHover(bool on)
        {
            if (linesButtonBg != null) linesButtonBg.color = on ? ButtonHoverColor : ButtonColor;
        }

        public void PressLinesButton() { if (LinesButtonPressed != null) LinesButtonPressed(); }

        static void Section(StringBuilder L, StringBuilder V, string title, string hex)
        {
            if (L.Length > 0) { L.Append("\n"); V.Append("\n"); }
            L.Append("<size=70%><color=" + hex + ">" + title + "</color></size>\n");
            V.Append("<size=70%> </size>\n");
        }

        static void Row(StringBuilder L, StringBuilder V, string label, string value)
        {
            L.Append(label).Append("\n");
            V.Append(value).Append("\n");
        }

        // "1.8° R", "3.2° L", "0.0°"
        static string Side(float rightPositive, string unit, string fmt = "0.0")
        {
            string mag = Mathf.Abs(rightPositive).ToString(fmt);
            if (Mathf.Abs(rightPositive) < 0.05f) return mag + unit;
            return mag + unit + (rightPositive > 0 ? " R" : " L");
        }

        static string Angle(float deg, string word)
        {
            return word == "square" ? Mathf.Abs(deg).ToString("0.0") + "° square" : Mathf.Abs(deg).ToString("0.0") + "° " + word;
        }

        void LateUpdate()
        {
            if (canvas == null || !canvas.gameObject.activeSelf) return;
            Camera cam = Camera.main;
            Transform t = canvas.transform;

            if (placement == Placement.InRoom)
            {
                // Placed once in front of the player; after that only GrabHandle moves it.
                if (!Spawned && GrabHandle.HeadReady(cam))
                {
                    Pose p = GrabHandle.SpawnPose(cam.transform, roomOffset);
                    t.SetPositionAndRotation(p.position, p.rotation);
                    Spawned = true;
                }
            }
            else if (placement == Placement.FollowHead && cam != null)
            {
                Transform head = cam.transform;
                Vector3 flatForward = Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized;
                if (flatForward.sqrMagnitude < 0.01f) flatForward = Vector3.forward;
                Vector3 right = Vector3.Cross(Vector3.up, flatForward);
                Vector3 goal = head.position + flatForward * followDistance + right * followViewOffset.x + Vector3.up * followViewOffset.y;
                t.position = Vector3.Lerp(t.position, goal, 1f - Mathf.Exp(-followSmoothing * Time.deltaTime));
            }
            else if (placement == Placement.ViewCorner && cam != null)
            {
                // Stays in the top-right of view, wherever the player looks
                Transform head = cam.transform;
                float k = 1f - Mathf.Exp(-cornerSmoothing * Time.deltaTime);
                t.position = Vector3.Lerp(t.position, head.TransformPoint(cornerOffset), k);
                t.rotation = Quaternion.Slerp(t.rotation, head.rotation, k);
            }
            else if (hasTee)
            {
                t.position = tee.position + tee.rotation * offsetFromTee;
            }

            if (faceThePlayer && cam != null && placement != Placement.ViewCorner && placement != Placement.InRoom)
            {
                Vector3 away = t.position - cam.transform.position;
                away.y = 0f; // stay upright
                if (away.sqrMagnitude > 1e-4f) t.rotation = Quaternion.LookRotation(away, Vector3.up);
            }

            // Small pop when a new shot arrives.
            if (pulse > 0f)
            {
                pulse = Mathf.Max(0f, pulse - Time.deltaTime * 4f);
                float s = metersPerPixel * (1f + 0.06f * pulse);
                t.localScale = new Vector3(s, s, s);
            }
        }

        void Build()
        {
            if (canvas != null) return;
            var go = new GameObject("Shot Stats Canvas");
            go.transform.SetParent(transform, false);
            canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvasRect = go.GetComponent<RectTransform>();
            canvasRect.sizeDelta = sizePixels;
            go.transform.localScale = Vector3.one * metersPerPixel;
            if (placement == Placement.InRoom) GrabHandle.Add(canvasRect);

            var bg = new GameObject("Background").AddComponent<Image>();
            bg.transform.SetParent(go.transform, false);
            bg.color = backgroundColor;
            Stretch(bg.rectTransform, 0f, 0f, 0f, 0f);

            // Header stops short of the Show/Hide lines button in the top-right corner.
            header = Text("Header", go.transform, 44f, TextAlignmentOptions.TopLeft);
            Stretch(header.rectTransform, 36f, 32f, 198f, sizePixels.y - 150f);

            linesButtonBg = new GameObject("Lines Button").AddComponent<Image>();
            linesButtonBg.transform.SetParent(go.transform, false);
            linesButtonBg.color = ButtonColor;
            linesButton = linesButtonBg.rectTransform;
            linesButton.anchorMin = linesButton.anchorMax = linesButton.pivot = new Vector2(1f, 1f);
            linesButton.anchoredPosition = new Vector2(-36f, -36f);
            linesButton.sizeDelta = new Vector2(150f, 56f);
            linesButtonLabel = Text("Label", linesButton, 24f, TextAlignmentOptions.Center);
            Stretch(linesButtonLabel.rectTransform, 0f, 0f, 0f, 0f);
            linesButton.gameObject.SetActive(false);

            labelsColumn = Text("Labels", go.transform, 26f, TextAlignmentOptions.TopLeft);
            Stretch(labelsColumn.rectTransform, 36f, 160f, sizePixels.x * 0.48f, 150f);
            valuesColumn = Text("Values", go.transform, 26f, TextAlignmentOptions.TopRight);
            Stretch(valuesColumn.rectTransform, sizePixels.x * 0.42f, 160f, 36f, 150f);
            labelsColumn.color = VizColors.TextMuted;

            footer = Text("Footer", go.transform, 25f, TextAlignmentOptions.BottomLeft);
            Stretch(footer.rectTransform, 36f, sizePixels.y - 150f, 36f, 28f);

            ShowWaiting("Waiting for a shot…");
        }

        TextMeshProUGUI Text(string name, Transform parent, float size, TextAlignmentOptions align)
        {
            var t = new GameObject(name).AddComponent<TextMeshProUGUI>();
            t.transform.SetParent(parent, false);
            if (font != null) t.font = font;
            t.fontSize = size;
            t.color = VizColors.Text;
            t.alignment = align;
            t.richText = true;
            t.lineSpacing = 4f;
            t.overflowMode = TextOverflowModes.Overflow;
            return t;
        }

        // Insets from the left, top, right and bottom edges of the parent, in pixels.
        static void Stretch(RectTransform rt, float left, float top, float right, float bottom)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = new Vector2(left, bottom);
            rt.offsetMax = new Vector2(-right, -top);
        }
    }
}