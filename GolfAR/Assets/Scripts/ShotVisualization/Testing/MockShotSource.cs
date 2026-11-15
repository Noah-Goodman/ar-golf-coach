using System.Collections;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// Fake launch-monitor shots for testing the visuals without the R10.
    /// Keys 1-6 fire the presets, Space fires the JSON box, C clears.
    /// The same actions are in the component's right-click (⋮) menu and callable from UI buttons.
    /// Delete or disable this once real shots flow in.
    /// </summary>
    public class MockShotSource : MonoBehaviour
    {
        [TextArea(8, 20)]
        public string testJson =
@"{
  ""type"": ""shot"",
  ""shotId"": 1234,
  ""receivedAt"": 1761500000123,
  ""ball"": {
    ""speedMph"": 132.4,
    ""launchAngleDeg"": 14.2,
    ""launchDirectionDeg"": 1.8,
    ""backspinRpm"": 3100,
    ""sidespinRpm"": -450,
    ""spinMeasured"": false
  },
  ""club"": {
    ""speedMph"": 92.1,
    ""faceAngleDeg"": 2.5,
    ""pathAngleDeg"": -1.5,
    ""attackAngleDeg"": -3.0
  }
}";

        public bool enableKeyboard = true;
        [Tooltip("Fire a random preset every few seconds, for demos.")]
        public bool autoCycle = false;
        public float autoCycleSeconds = 8f;

        int nextId = 1;

        void Start()
        {
            if (autoCycle) StartCoroutine(Cycle());
        }

        IEnumerator Cycle()
        {
            yield return new WaitForSeconds(1f);
            while (autoCycle)
            {
                FirePreset(Random.Range(0, 6));
                yield return new WaitForSeconds(autoCycleSeconds);
            }
        }

        void Update()
        {
            if (!enableKeyboard) return;
#if ENABLE_INPUT_SYSTEM
            var kb = Keyboard.current;
            if (kb == null) return;
            if (kb.digit1Key.wasPressedThisFrame) FirePreset(0);
            if (kb.digit2Key.wasPressedThisFrame) FirePreset(1);
            if (kb.digit3Key.wasPressedThisFrame) FirePreset(2);
            if (kb.digit4Key.wasPressedThisFrame) FirePreset(3);
            if (kb.digit5Key.wasPressedThisFrame) FirePreset(4);
            if (kb.digit6Key.wasPressedThisFrame) FirePreset(5);
            if (kb.spaceKey.wasPressedThisFrame) FireJson();
            if (kb.cKey.wasPressedThisFrame) ClearAll();
#else
            if (Input.GetKeyDown(KeyCode.Alpha1)) FirePreset(0);
            if (Input.GetKeyDown(KeyCode.Alpha2)) FirePreset(1);
            if (Input.GetKeyDown(KeyCode.Alpha3)) FirePreset(2);
            if (Input.GetKeyDown(KeyCode.Alpha4)) FirePreset(3);
            if (Input.GetKeyDown(KeyCode.Alpha5)) FirePreset(4);
            if (Input.GetKeyDown(KeyCode.Alpha6)) FirePreset(5);
            if (Input.GetKeyDown(KeyCode.Space)) FireJson();
            if (Input.GetKeyDown(KeyCode.C)) ClearAll();
#endif
        }

        [ContextMenu("Fire JSON box")]
        public void FireJson()
        {
            if (!ShotEvents.PublishJson(testJson)) Debug.LogWarning("[MockShotSource] JSON box is not a valid shot.");
        }

        [ContextMenu("Fire: 1 Straight 7-iron")] void P0() { FirePreset(0); }
        [ContextMenu("Fire: 2 Push slice (driver)")] void P1() { FirePreset(1); }
        [ContextMenu("Fire: 3 Pull hook")] void P2() { FirePreset(2); }
        [ContextMenu("Fire: 4 Draw")] void P3() { FirePreset(3); }
        [ContextMenu("Fire: 5 Fade wedge")] void P4() { FirePreset(4); }
        [ContextMenu("Fire: 6 Topped / low")] void P5() { FirePreset(5); }

        [ContextMenu("Clear all shots")]
        public void ClearAll()
        {
            var c = FindAnyObjectByType<ShotVisualizationController>();
            if (c != null) c.ClearAll();
        }

        /// <summary>0-5. Hook this to a UI button or controller input for in-headset testing.
        /// Angles assume a right-handed golfer.</summary>
        public void FirePreset(int index)
        {
            //                       ball mph launch dir  back  side  club mph face  path  aoa
            switch (index)
            {
                case 0: Fire(120f, 16.3f, 0.3f, 7000f, 100f, 90f, 0.2f, 0.0f, -4.0f); break;   // straight 7-iron
                case 1: Fire(150f, 12.0f, 4.5f, 3200f, 1400f, 104f, 6.0f, -2.0f, -1.0f); break; // push slice
                case 2: Fire(140f, 11.0f, -5.0f, 2600f, 1300f, 98f, -8.0f, 0.5f, -2.0f); break; // pull hook
                case 3: Fire(125f, 15.5f, 1.5f, 6200f, 450f, 88f, -1.0f, 2.5f, -3.5f); break;   // draw
                case 4: Fire(98f, 25.0f, -1.5f, 8800f, 500f, 80f, 0.5f, -2.5f, -5.0f); break;   // fade wedge
                case 5: Fire(70f, 4.0f, 1.0f, 1500f, 200f, 85f, 1.0f, 0.5f, 3.0f); break;       // topped
                default: Debug.LogWarning("[MockShotSource] No preset " + index); break;
            }
        }

        void Fire(float ballMph, float launch, float dir, float back, float sideAbs,
                  float clubMph, float face, float path, float aoa)
        {
            var shot = new ShotData
            {
                type = "shot",
                shotId = nextId++,
                receivedAt = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ball = new BallData
                {
                    speedMph = ballMph, launchAngleDeg = launch, launchDirectionDeg = dir,
                    backspinRpm = back,
                    sidespinRpm = sideAbs * Mathf.Sign(face - path), // + = curves right in these presets
                    spinMeasured = false
                },
                club = new ClubData { speedMph = clubMph, faceAngleDeg = face, pathAngleDeg = path, attackAngleDeg = aoa }
            };
            ShotEvents.Publish(shot);
        }
    }
}
