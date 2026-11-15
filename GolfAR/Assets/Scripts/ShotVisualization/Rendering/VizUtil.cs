using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.Rendering;

namespace ArGolfCoach.Visualization
{
    /// <summary>Shared colors and small helpers for building the visuals at runtime,
    /// so the scene needs no prefabs to get started.</summary>
    public static class VizColors
    {
        // Blue and orange stay distinguishable for color-blind players. Text labels always back them up.
        public static readonly Color Path = Hex("5FA8D3");
        public static readonly Color Face = Hex("E8875A");
        public static readonly Color Flight = Hex("C8E25C");
        public static readonly Color Target = new Color(0.95f, 0.94f, 0.90f, 0.7f);
        public static readonly Color Shadow = new Color(0f, 0f, 0f, 0.35f);
        public static readonly Color History = new Color(1f, 1f, 1f, 0.25f);
        public static readonly Color Text = Hex("F3F0E6");
        public static readonly Color TextMuted = Hex("A9BDB2");
        public static readonly Color Panel = new Color(0.07f, 0.15f, 0.12f, 0.88f);
        public static readonly Color Good = Hex("C8E25C");
        public static readonly Color Miss = Hex("E8875A");

        public static Color Hex(string hex)
        {
            Color c;
            return ColorUtility.TryParseHtmlString("#" + hex, out c) ? c : Color.magenta;
        }

        public static string ToHex(Color c) { return "#" + ColorUtility.ToHtmlStringRGB(c); }

        public static Color WithAlpha(Color c, float a) { c.a = a; return c; }
    }

    public static class VizUtil
    {
        static Material fallbackLineMaterial;

        /// <summary>A vertex-colored unlit material for LineRenderers when none is assigned.
        /// For the Quest build, assign a material using "Universal Render Pipeline/Particles/Unlit"
        /// (Surface Type: Transparent) in the inspector so the shader is guaranteed to ship.</summary>
        public static Material DefaultLineMaterial
        {
            get
            {
                if (fallbackLineMaterial != null) return fallbackLineMaterial;
                string[] candidates =
                {
                    "Universal Render Pipeline/Particles/Unlit",
                    "Sprites/Default",
                    "Legacy Shaders/Particles/Alpha Blended Premultiply"
                };
                foreach (string name in candidates)
                {
                    Shader shader = Shader.Find(name);
                    if (shader == null) continue;
                    fallbackLineMaterial = new Material(shader);
                    fallbackLineMaterial.name = "ShotViz Line (runtime)";
                    if (name.StartsWith("Universal"))
                    {
                        // Transparent + vertex colors, so LineRenderer colors and alpha show up.
                        fallbackLineMaterial.SetFloat("_Surface", 1f);
                        fallbackLineMaterial.SetFloat("_Blend", 0f);
                        fallbackLineMaterial.SetFloat("_ColorMode", 0f);
                        fallbackLineMaterial.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                        fallbackLineMaterial.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
                        fallbackLineMaterial.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
                        fallbackLineMaterial.SetInt("_ZWrite", 0);
                        fallbackLineMaterial.renderQueue = (int)RenderQueue.Transparent;
                    }
                    return fallbackLineMaterial;
                }
                Debug.LogWarning("[ShotViz] No line shader found. Assign a Line Material in the inspector.");
                return null;
            }
        }

        public static LineRenderer CreateLine(string name, Transform parent, Material material, Color color, float width)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var lr = go.AddComponent<LineRenderer>();
            lr.useWorldSpace = true;
            lr.material = material != null ? material : DefaultLineMaterial;
            lr.startColor = color;
            lr.endColor = color;
            lr.startWidth = width;
            lr.endWidth = width;
            lr.numCapVertices = 4;
            lr.numCornerVertices = 2;
            lr.shadowCastingMode = ShadowCastingMode.Off;
            lr.receiveShadows = false;
            lr.positionCount = 0;
            return lr;
        }

        public static void SetColor(LineRenderer lr, Color color)
        {
            if (lr == null) return;
            lr.startColor = color;
            lr.endColor = color;
        }

        /// <summary>A flat circle on the ground (XZ plane) around center.</summary>
        public static void SetCircle(LineRenderer lr, Vector3 center, Quaternion rotation, float radius, int segments = 48)
        {
            lr.loop = true;
            lr.positionCount = segments;
            for (int i = 0; i < segments; i++)
            {
                float a = i * Mathf.PI * 2f / segments;
                lr.SetPosition(i, center + rotation * new Vector3(Mathf.Cos(a) * radius, 0f, Mathf.Sin(a) * radius));
            }
        }

        /// <summary>World-space text that turns to face the player and keeps a readable size.</summary>
        public static TextMeshPro CreateLabel(string name, Transform parent, Color color, float sizePerMeter = 0.2f, TMP_FontAsset font = null)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var tmp = go.AddComponent<TextMeshPro>();
            if (font != null) tmp.font = font;
            tmp.fontSize = 1f; // about 0.1 m per line at scale 1; Billboard scales it with distance
            tmp.color = color;
            tmp.alignment = TextAlignmentOptions.Center;
            tmp.overflowMode = TextOverflowModes.Overflow;
            tmp.richText = true;
            tmp.rectTransform.sizeDelta = new Vector2(6f, 1.5f);
            var bb = go.AddComponent<Billboard>();
            bb.sizePerMeter = sizePerMeter;
            return tmp;
        }

        public static void SetPositions(LineRenderer lr, List<Vector3> worldPoints)
        {
            lr.positionCount = worldPoints.Count;
            for (int i = 0; i < worldPoints.Count; i++) lr.SetPosition(i, worldPoints[i]);
        }

        public static void DestroySafe(Object o)
        {
            if (o == null) return;
            if (Application.isPlaying) Object.Destroy(o);
            else Object.DestroyImmediate(o);
        }
    }

    /// <summary>Turns a label toward the camera and (optionally) scales it so it stays the
    /// same apparent size whether it is 1 m or 200 m away.</summary>
    public class Billboard : MonoBehaviour
    {
        public bool keepReadableSize = true;
        [Tooltip("Scale gained per meter of distance. 0.2 gives text about 1.2 degrees tall.")]
        public float sizePerMeter = 0.2f;
        public float minScale = 0.15f;
        public float maxScale = 80f;

        static Camera cachedCamera;

        void LateUpdate()
        {
            Camera cam = cachedCamera;
            if (cam == null || !cam.isActiveAndEnabled) cam = cachedCamera = Camera.main;
            if (cam == null) return;

            Vector3 toLabel = transform.position - cam.transform.position;
            if (toLabel.sqrMagnitude < 1e-6f) return;
            transform.rotation = Quaternion.LookRotation(toLabel, Vector3.up);
            if (keepReadableSize)
            {
                float s = Mathf.Clamp(toLabel.magnitude * sizePerMeter, minScale, maxScale);
                transform.localScale = new Vector3(s, s, s);
            }
        }
    }
}
