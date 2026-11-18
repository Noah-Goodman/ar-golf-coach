using ArGolfCoach.Visualization;
using Meta.XR;
using UnityEngine;
using UnityEngine.Serialization;
using UnityEngine.XR;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

// Ball and target setup, with either controller:
// 1) Point the ray at the real ball and pull the trigger. The ray lands on real surfaces through
//    Quest 3 depth sensing, or on the floor plane when depth has no answer.
// 2) Point at the target and pull the trigger. The target line follows the controller's heading.
// The setup card (SetupPanel, left of the stats card) shows the steps, the "Show target line"
// checkbox and, after setup, Re-mark ball / Re-aim buttons. B or Y restarts from step 1.
// Both cards stay put in the room; point at the bar under one and hold the trigger to move it.
// The stats card's Show/Hide lines button is clicked the same way as the setup card's controls.
// A fires a mock shot once setup is done.
// In the Editor with no headset, the camera is put at a golfer's eye height, setup is skipped,
// and the mouse clicks the checkbox and drags the cards by their bars.
public class BallPlacer : MonoBehaviour
{
    [Tooltip("OVRCameraRig > RightControllerAnchor. Filled from the camera rig if empty.")]
    [FormerlySerializedAs("controller")] public Transform rightController;
    [Tooltip("OVRCameraRig > LeftControllerAnchor. Filled from the camera rig if empty.")]
    public Transform leftController;
    public Transform ballAnchor;      // also drag into ShotVisualizationController > Tee Origin
    public MockShotSource mockShots;  // optional, remove with MockShotSource later
    [Tooltip("The setup card sits to the left of this card, at the same scale. Found in the scene if empty.")]
    public ShotStatsPanel statsPanel;
    public float floorY = 0f;         // 0 with Floor Level tracking origin

    [Header("Ray")]
    public float maxRayDistance = 10f;
    [Tooltip("Ray length while aiming, and when marking finds no surface.")]
    public float aimRayLength = 3f;
    [Tooltip("Vertex-colored transparent unlit material. Leave empty to create one at runtime.")]
    public Material lineMaterial;

    [Header("Target line")]
    public bool showDirectionLine = true;
    public float directionLineLength = 5f;

    [Header("Editor preview (no headset)")]
    public Transform cameraRig;       // [BuildingBlock] Camera Rig
    public Vector3 editorEyePosition = new Vector3(-0.8f, 1.6f, -0.4f); // golfer stands left of the ball
    public Vector3 editorEyeAngles = new Vector3(40f, 60f, 0f);         // look down at the ball and toward the target

    static readonly Color RayColor = new Color(1f, 1f, 1f, 0.8f);
    static readonly Color RayNoHitColor = new Color(1f, 1f, 1f, 0.25f);
    const float BallRadius = 0.0215f;

    SetupPanel.Step step = SetupPanel.Step.MarkBall;
    bool editorPreview;
    bool leftActive; // the ray comes from the controller last used
    EnvironmentRaycastManager depth;
    SetupPanel panel;
    LineRenderer ray, reticle, directionLine;
    Transform ghostBall;
    GrabHandle dragging;
    bool dragLeft; // which controller is dragging

    void Start()
    {
        var rig = FindAnyObjectByType<OVRCameraRig>();
        if (rig != null)
        {
            if (rightController == null) rightController = rig.rightControllerAnchor;
            if (leftController == null) leftController = rig.leftControllerAnchor;
        }
        if (statsPanel == null) statsPanel = FindAnyObjectByType<ShotStatsPanel>();

        if (Application.isEditor && !XRSettings.isDeviceActive && cameraRig)
        {
            cameraRig.SetPositionAndRotation(editorEyePosition, Quaternion.Euler(editorEyeAngles));
            editorPreview = true;
            step = SetupPanel.Step.Done; // no controller to place with, keep the ball where it is
        }

        if (!editorPreview && EnvironmentRaycastManager.IsSupported)
        {
            // Depth raycasts need the spatial data permission; until it is granted, the floor plane is used.
            if (!OVRPermissionsRequester.IsPermissionGranted(OVRPermissionsRequester.Permission.Scene))
                OVRPermissionsRequester.Request(new[] { OVRPermissionsRequester.Permission.Scene });
            depth = FindAnyObjectByType<EnvironmentRaycastManager>();
            if (depth == null) depth = gameObject.AddComponent<EnvironmentRaycastManager>();
        }

        Material mat = lineMaterial != null ? lineMaterial : VizUtil.DefaultLineMaterial;
        ray = VizUtil.CreateLine("Controller Ray", transform, mat, RayColor, 0.004f);
        reticle = VizUtil.CreateLine("Ray Reticle", transform, mat, VizColors.Good, 0.006f);
        directionLine = VizUtil.CreateLine("Target Direction Line", transform, mat, VizColors.Target, 0.02f);
        ghostBall = CreateGhostBall();

        panel = gameObject.AddComponent<SetupPanel>();
        panel.Build(statsPanel);
        RefreshPanel();
    }

    void Update()
    {
        ray.positionCount = 0;
        reticle.positionCount = 0;
        ghostBall.gameObject.SetActive(false);

        if (editorPreview) EditorMouse();
        else Headset();

        UpdateDirectionLine();
    }

    void Headset()
    {
        bool rightDown = OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.RTouch);
        bool leftDown = OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.LTouch);
        bool rightTouch = OVRInput.Get(OVRInput.Touch.PrimaryIndexTrigger, OVRInput.Controller.RTouch);
        bool leftTouch = OVRInput.Get(OVRInput.Touch.PrimaryIndexTrigger, OVRInput.Controller.LTouch);
        // A finger resting on a trigger moves the ray to that controller before it is pulled.
        if (rightDown || (rightTouch && !leftTouch)) leftActive = false;
        if (leftDown || (leftTouch && !rightTouch)) leftActive = true;
        bool pulled = rightDown || leftDown;

        if (OVRInput.GetDown(OVRInput.Button.Two, OVRInput.Controller.RTouch) ||
            OVRInput.GetDown(OVRInput.Button.Two, OVRInput.Controller.LTouch))
            SetStep(SetupPanel.Step.MarkBall);
        if (mockShots && step == SetupPanel.Step.Done && OVRInput.GetDown(OVRInput.Button.One, OVRInput.Controller.RTouch))
            mockShots.FirePreset(Random.Range(0, 6));

        if (dragging != null)
        {
            Transform dragHand = dragLeft ? leftController : rightController;
            bool held = OVRInput.Get(OVRInput.Button.PrimaryIndexTrigger,
                                     dragLeft ? OVRInput.Controller.LTouch : OVRInput.Controller.RTouch);
            if (held && dragHand != null && ContinueDrag(new Ray(dragHand.position, dragHand.forward))) return;
            EndDrag();
        }

        Transform hand = leftActive ? leftController : rightController;
        if (hand == null) hand = leftActive ? rightController : leftController;
        if (hand == null) return;
        var pointer = new Ray(hand.position, hand.forward);

        // The cards take the ray first, in every step.
        if (PointAtCards(pointer, maxRayDistance, pulled, out Vector3 cardPoint))
        {
            DrawRay(pointer.origin, cardPoint, RayColor);
            if (dragging != null) dragLeft = leftActive;
            return;
        }

        switch (step)
        {
            case SetupPanel.Step.MarkBall:
                if (SurfaceHit(pointer, out Vector3 point, out Vector3 normal))
                {
                    DrawRay(pointer.origin, point, RayColor);
                    ShowReticle(point, normal);
                    if (pulled)
                    {
                        ballAnchor.position = point;
                        SetStep(SetupPanel.Step.Aim);
                    }
                }
                else DrawRay(pointer.origin, pointer.GetPoint(aimRayLength), RayNoHitColor);
                break;

            case SetupPanel.Step.Aim:
                Vector3 aim = Vector3.ProjectOnPlane(hand.forward, Vector3.up);
                if (aim.sqrMagnitude > 0.001f) ballAnchor.rotation = Quaternion.LookRotation(aim);
                DrawRay(pointer.origin, pointer.GetPoint(aimRayLength), RayColor);
                if (pulled) SetStep(SetupPanel.Step.Done);
                break;
        }
    }

    // Editor preview: the mouse stands in for the ray, to click the checkbox and drag the cards.
    void EditorMouse()
    {
#if ENABLE_INPUT_SYSTEM
        Camera cam = Camera.main;
        var mouse = Mouse.current;
        if (cam == null || mouse == null) return;
        var pointer = cam.ScreenPointToRay(mouse.position.ReadValue());
        if (dragging != null)
        {
            if (mouse.leftButton.isPressed && ContinueDrag(pointer)) return;
            EndDrag();
        }
        PointAtCards(pointer, 100f, mouse.leftButton.wasPressedThisFrame, out _);
#endif
    }

    // Finds the nearest card or card handle on the ray, highlights it, and acts on a trigger
    // pull: a handle starts a drag, a setup card control is clicked. True when a card is hit.
    bool PointAtCards(Ray pointer, float maxDistance, bool pulled, out Vector3 point)
    {
        GrabHandle hit = null;
        var hitPart = GrabHandle.Part.None;
        float nearest = float.MaxValue;
        point = Vector3.zero;
        foreach (var h in GrabHandle.All)
        {
            var part = h.Raycast(pointer, maxDistance, out Vector3 p, out float d);
            if (part == GrabHandle.Part.None || d >= nearest) continue;
            hit = h; hitPart = part; point = p; nearest = d;
        }
        foreach (var h in GrabHandle.All) h.SetHover(h == hit && hitPart == GrabHandle.Part.Handle);

        bool onCard = hit != null && hitPart == GrabHandle.Part.Card;
        var element = onCard && hit == panel.Handle ? panel.ElementAt(point) : SetupPanel.Element.None;
        bool linesButton = onCard && statsPanel != null && hit.Card == statsPanel.Card && statsPanel.LinesButtonAt(point);
        panel.SetHover(element);
        if (statsPanel != null) statsPanel.SetLinesButtonHover(linesButton);
        if (hit == null) return false;

        if (pulled)
        {
            if (hitPart == GrabHandle.Part.Handle)
            {
                dragging = hit;
                dragging.BeginDrag(pointer, point);
            }
            else if (linesButton) statsPanel.PressLinesButton();
            else Click(element);
        }
        return true;
    }

    bool ContinueDrag(Ray pointer)
    {
        Camera cam = Camera.main;
        if (dragging == null || !dragging.isActiveAndEnabled || cam == null) return false;
        Vector3 grab = dragging.Drag(pointer, cam.transform.position);
        DrawRay(pointer.origin, grab, RayColor);
        return true;
    }

    void EndDrag()
    {
        if (dragging != null) dragging.EndDrag();
        dragging = null;
    }

    void Click(SetupPanel.Element element)
    {
        switch (element)
        {
            case SetupPanel.Element.Checkbox:
                showDirectionLine = !showDirectionLine;
                RefreshPanel();
                break;
            case SetupPanel.Element.RemarkButton: SetStep(SetupPanel.Step.MarkBall); break;
            case SetupPanel.Element.ReaimButton: SetStep(SetupPanel.Step.Aim); break;
        }
    }

    void SetStep(SetupPanel.Step s)
    {
        step = s;
        RefreshPanel();
    }

    void RefreshPanel()
    {
        if (panel != null) panel.Show(step, showDirectionLine, !editorPreview);
    }

    // Real surface from depth when it has a hit; otherwise the floor plane.
    bool SurfaceHit(Ray pointer, out Vector3 point, out Vector3 normal)
    {
        if (depth != null && depth.isActiveAndEnabled && depth.Raycast(pointer, out EnvironmentRaycastHit hit, maxRayDistance))
        {
            point = hit.point;
            normal = hit.normalConfidence > 0f ? hit.normal : Vector3.up;
            return true;
        }
        normal = Vector3.up;
        point = Vector3.zero;
        if (pointer.direction.y > -0.01f) return false; // level or upward never meets the floor
        float distance = (floorY - pointer.origin.y) / pointer.direction.y;
        if (distance <= 0f || distance > maxRayDistance) return false;
        point = pointer.GetPoint(distance);
        return true;
    }

    void UpdateDirectionLine()
    {
        bool visible = step == SetupPanel.Step.Aim || (step == SetupPanel.Step.Done && showDirectionLine);
        if (!visible || ballAnchor == null) { directionLine.positionCount = 0; return; }
        Vector3 forward = Vector3.ProjectOnPlane(ballAnchor.forward, Vector3.up);
        if (forward.sqrMagnitude < 1e-4f) forward = Vector3.forward;
        Vector3 start = ballAnchor.position + Vector3.up * 0.005f;
        directionLine.positionCount = 2;
        directionLine.SetPosition(0, start);
        directionLine.SetPosition(1, start + forward.normalized * directionLineLength);
    }

    void DrawRay(Vector3 from, Vector3 to, Color color)
    {
        VizUtil.SetColor(ray, color);
        ray.positionCount = 2;
        ray.SetPosition(0, from);
        ray.SetPosition(1, to);
    }

    // Ring on the surface plus a ball-sized preview of where the ball will be marked.
    void ShowReticle(Vector3 point, Vector3 normal)
    {
        Quaternion onSurface = Quaternion.FromToRotation(Vector3.up, normal);
        VizUtil.SetCircle(reticle, point + normal * 0.002f, onSurface, 0.04f, 32);
        ghostBall.gameObject.SetActive(true);
        ghostBall.position = point + normal * BallRadius;
    }

    Transform CreateGhostBall()
    {
        var ball = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        ball.name = "Ball Preview";
        Destroy(ball.GetComponent<Collider>());
        ball.transform.SetParent(transform, false);
        ball.transform.localScale = Vector3.one * BallRadius * 2f;
        var r = ball.GetComponent<Renderer>();
        if (r != null) r.material.color = VizColors.Good;
        ball.SetActive(false);
        return ball.transform;
    }
}
