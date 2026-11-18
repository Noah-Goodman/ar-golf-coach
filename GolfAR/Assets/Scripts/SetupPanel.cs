using ArGolfCoach.Visualization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

// Setup card, placed in the room just left of the stats card at the same scale, and moved with
// the bar under it (GrabHandle). Lists the two setup steps, holds the "Show target line"
// checkbox and, once setup is done, the Re-mark ball and Re-aim buttons. BallPlacer creates it
// and drives it; clicks are found by ElementAt() so no EventSystem is needed.
public class SetupPanel : MonoBehaviour
{
    public enum Step { MarkBall, Aim, Done }
    public enum Element { None, Background, Checkbox, RemarkButton, ReaimButton }

    [Tooltip("Where the card appears at launch when there is no in-room stats card to sit beside: " +
             "from the eyes (x right, y up, z forward), in meters.")]
    public Vector3 roomOffset = new Vector3(-0.26f, 0.28f, 1.3f);

    const float Width = 560f, Height = 400f, Pad = 32f;
    const float RowHeight = 75f; // 6 cm at 0.0008 m per pixel
    const float Gap = 0.04f;     // meters between this card and the stats card

    Canvas canvas;
    RectTransform canvasRect;
    TextMeshProUGUI title, steps;
    RectTransform checkboxRow, remarkButton, reaimButton;
    Image checkboxRowBg, checkFill, remarkBg, reaimBg;
    ShotStatsPanel stats;
    float metersPerPixel;
    bool spawned;

    public GrabHandle Handle { get; private set; }

    static readonly Color ButtonColor = new Color(1f, 1f, 1f, 0.10f);
    static readonly Color HoverColor = new Color(1f, 1f, 1f, 0.28f);

    // Same font, colors and scale as the stats card; sits to its left with the tops lined up.
    public void Build(ShotStatsPanel stats)
    {
        if (canvas != null) return;
        this.stats = stats;
        float mpp = metersPerPixel = stats != null ? stats.metersPerPixel : 0.0008f;
        TMP_FontAsset font = stats != null ? stats.font : null;
        Color background = stats != null ? stats.backgroundColor : VizColors.Panel;

        var go = new GameObject("Setup Canvas");
        go.transform.SetParent(transform, false);
        canvas = go.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.WorldSpace;
        canvasRect = go.GetComponent<RectTransform>();
        canvasRect.sizeDelta = new Vector2(Width, Height);
        go.transform.localScale = Vector3.one * mpp;
        Handle = GrabHandle.Add(canvasRect);

        var bg = NewImage("Background", go.transform, background);
        Place(bg.rectTransform, 0f, 0f, Width, Height);

        title = NewText("Title", go.transform, font, 26f, TextAlignmentOptions.TopLeft);
        Place(title.rectTransform, Pad, Pad, Width - 2 * Pad, 40f);
        title.color = VizColors.TextMuted;
        title.text = "SET UP YOUR SHOT";

        steps = NewText("Steps", go.transform, font, 28f, TextAlignmentOptions.TopLeft);
        Place(steps.rectTransform, Pad, Pad + 48f, Width - 2 * Pad, 100f);

        // Checkbox row: the whole row is the click target.
        checkboxRowBg = NewImage("Target Line Toggle", go.transform, Color.clear);
        checkboxRow = checkboxRowBg.rectTransform;
        Place(checkboxRow, Pad - 8f, 172f, Width - 2 * Pad + 16f, RowHeight);
        var box = NewImage("Box", checkboxRow, VizColors.Text);
        Place(box.rectTransform, 12f, 10f, 55f, 55f);
        var boxInner = NewImage("Inner", box.rectTransform, background);
        Place(boxInner.rectTransform, 5f, 5f, 45f, 45f);
        checkFill = NewImage("Check", boxInner.rectTransform, VizColors.Good);
        Place(checkFill.rectTransform, 7f, 7f, 31f, 31f);
        var label = NewText("Label", checkboxRow, font, 28f, TextAlignmentOptions.MidlineLeft);
        Place(label.rectTransform, 88f, 0f, 380f, RowHeight);
        label.text = "Show target line";

        float buttonWidth = (Width - 2 * Pad - 16f) * 0.5f;
        remarkBg = NewButton("Re-mark Button", "Re-mark ball", go.transform, font, Pad, 270f, buttonWidth);
        reaimBg = NewButton("Re-aim Button", "Re-aim", go.transform, font, Pad + buttonWidth + 16f, 270f, buttonWidth);
        remarkButton = remarkBg.rectTransform;
        reaimButton = reaimBg.rectTransform;
    }

    public void Show(Step step, bool directionLineOn, bool showRedoButtons)
    {
        string muted = VizColors.ToHex(VizColors.TextMuted);
        string accent = VizColors.ToHex(VizColors.Good);
        string one = "1. Point at the ball, pull trigger";
        string two = "2. Point at your target, pull trigger";
        steps.text = step switch
        {
            Step.MarkBall => "<color=" + accent + ">> " + one + "</color>\n<color=" + muted + ">   " + two + "</color>",
            Step.Aim => "<color=" + muted + ">   " + one + "</color>\n<color=" + accent + ">> " + two + "</color>",
            _ => "<color=" + muted + ">   " + one + "\n   " + two + "</color>",
        };
        title.text = step == Step.Done ? "READY - HIT AWAY" : "SET UP YOUR SHOT";
        checkFill.enabled = directionLineOn;
        bool buttons = step == Step.Done && showRedoButtons;
        remarkButton.gameObject.SetActive(buttons);
        reaimButton.gameObject.SetActive(buttons);
    }

    public void SetHover(Element e)
    {
        if (canvas == null) return;
        checkboxRowBg.color = e == Element.Checkbox ? HoverColor : Color.clear;
        remarkBg.color = e == Element.RemarkButton ? HoverColor : ButtonColor;
        reaimBg.color = e == Element.ReaimButton ? HoverColor : ButtonColor;
    }

    // Which control is at a point on the card (from Handle.Raycast).
    public Element ElementAt(Vector3 point)
    {
        if (canvas == null || !GrabHandle.Contains(canvasRect, point)) return Element.None;
        if (GrabHandle.Contains(checkboxRow, point)) return Element.Checkbox;
        if (remarkButton.gameObject.activeSelf && GrabHandle.Contains(remarkButton, point)) return Element.RemarkButton;
        if (reaimButton.gameObject.activeSelf && GrabHandle.Contains(reaimButton, point)) return Element.ReaimButton;
        return Element.Background;
    }

    // Placed once: beside the in-room stats card with the tops lined up, or in front of the
    // player when there is none. After that only the handle moves it.
    void LateUpdate()
    {
        if (canvas == null || spawned) return;
        Transform t = canvas.transform;
        if (stats != null && stats.placement == ShotStatsPanel.Placement.InRoom)
        {
            if (!stats.Spawned) return;
            Transform s = stats.Card;
            Vector2 statsSize = stats.sizePixels * stats.metersPerPixel;
            Vector2 size = new Vector2(Width, Height) * metersPerPixel;
            t.SetPositionAndRotation(
                s.position - s.right * (statsSize.x * 0.5f + Gap + size.x * 0.5f) + s.up * (statsSize.y - size.y) * 0.5f,
                s.rotation);
        }
        else
        {
            Camera cam = Camera.main;
            if (!GrabHandle.HeadReady(cam)) return;
            Pose p = GrabHandle.SpawnPose(cam.transform, roomOffset);
            t.SetPositionAndRotation(p.position, p.rotation);
        }
        spawned = true;
    }

    Image NewButton(string name, string text, Transform parent, TMP_FontAsset font, float left, float top, float width)
    {
        var bg = NewImage(name, parent, ButtonColor);
        Place(bg.rectTransform, left, top, width, RowHeight);
        var label = NewText("Label", bg.rectTransform, font, 28f, TextAlignmentOptions.Center);
        Place(label.rectTransform, 0f, 0f, width, RowHeight);
        label.text = text;
        return bg;
    }

    static Image NewImage(string name, Transform parent, Color color)
    {
        var img = new GameObject(name).AddComponent<Image>();
        img.transform.SetParent(parent, false);
        img.color = color;
        return img;
    }

    static TextMeshProUGUI NewText(string name, Transform parent, TMP_FontAsset font, float size, TextAlignmentOptions align)
    {
        var t = new GameObject(name).AddComponent<TextMeshProUGUI>();
        t.transform.SetParent(parent, false);
        if (font != null) t.font = font;
        t.fontSize = size;
        t.color = VizColors.Text;
        t.alignment = align;
        t.richText = true;
        t.overflowMode = TextOverflowModes.Overflow;
        t.raycastTarget = false;
        return t;
    }

    // Top-left anchored rect, in pixels from the parent's top-left corner.
    static void Place(RectTransform rt, float left, float top, float width, float height)
    {
        rt.anchorMin = rt.anchorMax = new Vector2(0f, 1f);
        rt.pivot = new Vector2(0f, 1f);
        rt.anchoredPosition = new Vector2(left, -top);
        rt.sizeDelta = new Vector2(width, height);
    }
}
