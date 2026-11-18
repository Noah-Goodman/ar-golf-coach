using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// Fades a set of runtime-built visuals: line and trail alpha, label alpha, and mesh objects
    /// (the ball, whose opaque material can't fade) by shrinking them. Remembers every starting
    /// value so Restore() puts things back exactly, which the caller does after hiding the roots.
    /// </summary>
    public class VisualFade
    {
        readonly List<(LineRenderer lr, Color start, Color end)> lines = new List<(LineRenderer, Color, Color)>();
        readonly List<(TrailRenderer tr, Gradient gradient)> trails = new List<(TrailRenderer, Gradient)>();
        readonly List<(TMP_Text text, float alpha)> labels = new List<(TMP_Text, float)>();
        readonly List<(Transform t, Vector3 scale)> meshes = new List<(Transform, Vector3)>();

        public VisualFade(IEnumerable<GameObject> roots)
        {
            foreach (GameObject root in roots)
            {
                if (root == null) continue;
                foreach (var lr in root.GetComponentsInChildren<LineRenderer>(true)) lines.Add((lr, lr.startColor, lr.endColor));
                foreach (var tr in root.GetComponentsInChildren<TrailRenderer>(true)) trails.Add((tr, tr.colorGradient));
                foreach (var text in root.GetComponentsInChildren<TMP_Text>(true)) labels.Add((text, text.alpha));
                foreach (var mr in root.GetComponentsInChildren<MeshRenderer>(true))
                    if (mr.GetComponent<TMP_Text>() == null) meshes.Add((mr.transform, mr.transform.localScale));
            }
        }

        /// <summary>1 = as captured, 0 = invisible.</summary>
        public void Apply(float k)
        {
            foreach (var (lr, start, end) in lines)
            {
                if (lr == null) continue;
                lr.startColor = Scale(start, k);
                lr.endColor = Scale(end, k);
            }
            foreach (var (tr, gradient) in trails)
            {
                if (tr == null) continue;
                var keys = gradient.alphaKeys;
                for (int i = 0; i < keys.Length; i++) keys[i].alpha *= k;
                var g = new Gradient();
                g.SetKeys(gradient.colorKeys, keys);
                tr.colorGradient = g;
            }
            foreach (var (text, alpha) in labels) if (text != null) text.alpha = alpha * k;
            foreach (var (t, scale) in meshes) if (t != null) t.localScale = scale * k;
        }

        public void Restore() { Apply(1f); }

        static Color Scale(Color c, float k) { c.a *= k; return c; }
    }
}
