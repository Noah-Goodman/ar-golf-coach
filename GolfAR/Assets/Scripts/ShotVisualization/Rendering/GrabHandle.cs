using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// Makes a world-space card movable the way Quest windows are: a bar under the card that the
    /// controller ray grabs while the trigger is held. The card keeps its distance along the ray,
    /// turns to face the player, and stays where it is dropped. Input lives in BallPlacer, which
    /// raycasts every handle in <see cref="All"/>.
    /// </summary>
    public class GrabHandle : MonoBehaviour
    {
        public enum Part { None, Card, Handle }

        public static readonly List<GrabHandle> All = new List<GrabHandle>();

        static readonly Color BarColor = new Color(1f, 1f, 1f, 0.45f);
        static readonly Color BarHoverColor = new Color(1f, 1f, 1f, 0.95f);

        RectTransform card, hitArea;
        Image bar;
        bool hover;
        float holdDistance;
        Vector3 localGrab;

        public bool IsHeld { get; private set; }
        public RectTransform Card { get { return card; } }

        /// <summary>Adds a handle bar under the card. Sizes are in the card's canvas pixels.</summary>
        public static GrabHandle Add(RectTransform canvasRect, float barWidth = 200f, float barHeight = 14f)
        {
            var h = canvasRect.gameObject.AddComponent<GrabHandle>();
            h.card = canvasRect;

            // A taller invisible area around the thin bar, so the ray finds it easily.
            var area = new GameObject("Grab Handle", typeof(RectTransform));
            h.hitArea = area.GetComponent<RectTransform>();
            h.hitArea.SetParent(canvasRect, false);
            h.hitArea.anchorMin = h.hitArea.anchorMax = new Vector2(0.5f, 0f);
            h.hitArea.pivot = new Vector2(0.5f, 1f);
            h.hitArea.anchoredPosition = new Vector2(0f, -6f);
            h.hitArea.sizeDelta = new Vector2(barWidth + 80f, barHeight + 44f);

            h.bar = new GameObject("Bar").AddComponent<Image>();
            h.bar.transform.SetParent(h.hitArea, false);
            h.bar.color = BarColor;
            h.bar.raycastTarget = false;
            var rt = h.bar.rectTransform;
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
            rt.anchoredPosition = Vector2.zero;
            rt.sizeDelta = new Vector2(barWidth, barHeight);
            return h;
        }

        void OnEnable() { All.Add(this); }
        void OnDisable() { All.Remove(this); IsHeld = false; }

        /// <summary>Where the ray meets this card or its handle, seen from the front.</summary>
        public Part Raycast(Ray ray, float maxDistance, out Vector3 point, out float distance)
        {
            point = Vector3.zero;
            distance = 0f;
            if (card == null || !card.gameObject.activeInHierarchy) return Part.None;
            if (!RayToPlane(card, ray, maxDistance, out point, out distance)) return Part.None;
            if (Contains(hitArea, point)) return Part.Handle;
            if (Contains(card, point)) return Part.Card;
            return Part.None;
        }

        public void SetHover(bool on)
        {
            if (hover == on || bar == null) return;
            hover = on;
            bar.color = on || IsHeld ? BarHoverColor : BarColor;
        }

        public void BeginDrag(Ray ray, Vector3 point)
        {
            IsHeld = true;
            holdDistance = Vector3.Distance(ray.origin, point);
            localGrab = card.InverseTransformPoint(point);
            bar.color = BarHoverColor;
        }

        /// <summary>Moves the card so the grabbed spot stays on the ray, facing the head.</summary>
        public Vector3 Drag(Ray ray, Vector3 headPosition)
        {
            Vector3 grabWorld = ray.GetPoint(holdDistance);
            Quaternion rotation = FacingAway(grabWorld, headPosition, card.rotation);
            Vector3 offset = rotation * Vector3.Scale(localGrab, card.lossyScale);
            card.SetPositionAndRotation(grabWorld - offset, rotation);
            return grabWorld;
        }

        public void EndDrag()
        {
            IsHeld = false;
            bar.color = hover ? BarHoverColor : BarColor;
        }

        /// <summary>True once the headset reports a real head pose (Floor Level origin puts the
        /// untracked head at the floor), or after two seconds in any case.</summary>
        public static bool HeadReady(Camera cam)
        {
            return cam != null && (cam.transform.position.y > 0.3f || Time.timeSinceLevelLoad > 2f);
        }

        /// <summary>A pose at offset from the head (x right, y up, z forward), upright and facing the player.</summary>
        public static Pose SpawnPose(Transform head, Vector3 offset)
        {
            Vector3 position = head.position + head.rotation * offset;
            return new Pose(position, FacingAway(position, head.position, Quaternion.identity));
        }

        // A world-space canvas reads correctly when its forward points away from the viewer.
        static Quaternion FacingAway(Vector3 position, Vector3 headPosition, Quaternion fallback)
        {
            Vector3 away = position - headPosition;
            away.y = 0f;
            return away.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(away, Vector3.up) : fallback;
        }

        static bool RayToPlane(RectTransform rt, Ray ray, float maxDistance, out Vector3 point, out float distance)
        {
            point = Vector3.zero;
            distance = 0f;
            if (Vector3.Dot(ray.direction, rt.forward) <= 0f) return false; // from behind
            var plane = new Plane(rt.forward, rt.position);
            if (!plane.Raycast(ray, out distance) || distance > maxDistance) return false;
            point = ray.GetPoint(distance);
            return true;
        }

        public static bool Contains(RectTransform rt, Vector3 worldPoint)
        {
            return rt.rect.Contains((Vector2)rt.InverseTransformPoint(worldPoint));
        }
    }
}
