using ArGolfCoach.Visualization;
using TMPro;
using UnityEngine;
using UnityEngine.XR;

// 1) Hold controller over the real ball, pull trigger to lock the spot.
// 2) Point controller at your target, pull trigger to lock the target line.
// B restarts placement. A fires a mock shot (headset testing).
// In the Editor with no headset, the camera is put at a golfer's eye height instead.
public class BallPlacer : MonoBehaviour
{
    public Transform controller;      // OVRCameraRig > RightControllerAnchor
    public Transform ballAnchor;      // also drag into ShotVisualizationController > Tee Origin
    public TextMeshPro hint;          // optional
    public MockShotSource mockShots;  // optional, remove with MockShotSource later
    public float floorY = 0f;         // 0 with Floor Level tracking origin

    [Header("Editor preview (no headset)")]
    public Transform cameraRig;       // [BuildingBlock] Camera Rig
    public Vector3 editorEyePosition = new Vector3(-0.8f, 1.6f, -0.4f); // golfer stands left of the ball
    public Vector3 editorEyeAngles = new Vector3(40f, 60f, 0f);         // look down at the ball and toward the target

    int step;

    void Start()
    {
        if (Application.isEditor && !XRSettings.isDeviceActive && cameraRig)
        {
            cameraRig.SetPositionAndRotation(editorEyePosition, Quaternion.Euler(editorEyeAngles));
            step = 2; // no controller to place with, keep the ball where it is
        }
    }

    void Update()
    {
        if (OVRInput.GetDown(OVRInput.Button.Two)) step = 0;
        if (mockShots && step == 2 && OVRInput.GetDown(OVRInput.Button.One)) mockShots.FirePreset(Random.Range(0, 6));
        bool trigger = OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.RTouch);

        if (step == 0)
        {
            var p = controller.position;
            ballAnchor.position = new Vector3(p.x, floorY, p.z); // follows controller until locked
            if (trigger) step = 1;
        }
        else if (step == 1)
        {
            var aim = controller.forward;
            aim.y = 0;
            if (aim.sqrMagnitude > 0.001f) ballAnchor.rotation = Quaternion.LookRotation(aim);
            if (trigger) step = 2;
        }

        if (hint) hint.text = step switch
        {
            0 => "Hold controller over the ball\nand pull trigger",
            1 => "Point at your target\nand pull trigger",
            _ => ""
        };
    }
}