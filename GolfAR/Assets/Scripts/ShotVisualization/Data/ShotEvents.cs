using System;
using System.Collections.Concurrent;
using UnityEngine;

namespace ArGolfCoach.Visualization
{
    /// <summary>
    /// The hand-off point between the launch-monitor code and the visuals.
    ///
    /// Whoever receives shots from the R10 / OpenGolfSim calls ShotEvents.PublishJson(json)
    /// or ShotEvents.Publish(shot). Both are safe to call from a background thread (a socket
    /// or serial reader, for example). Listeners are always invoked on Unity's main thread.
    /// </summary>
    public static class ShotEvents
    {
        /// <summary>Raised on the main thread for every valid shot.</summary>
        public static event Action<ShotData> ShotReceived;

        static readonly ConcurrentQueue<ShotData> pending = new ConcurrentQueue<ShotData>();

        public static void Publish(ShotData shot)
        {
            if (shot != null) pending.Enqueue(shot);
        }

        /// <summary>Parses and publishes. Returns false if the JSON was not a usable shot.</summary>
        public static bool PublishJson(string json)
        {
            ShotData shot = ShotData.FromJson(json);
            if (shot == null) return false;
            pending.Enqueue(shot);
            return true;
        }

        // Called every frame by the dispatcher below.
        internal static void Drain()
        {
            ShotData shot;
            while (pending.TryDequeue(out shot))
            {
                Action<ShotData> handler = ShotReceived;
                if (handler == null) continue;
                try { handler(shot); }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void CreateDispatcher()
        {
            var go = new GameObject("[ShotEvents Dispatcher]");
            go.hideFlags = HideFlags.HideInHierarchy;
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.AddComponent<ShotEventDispatcher>();
        }
    }

    /// <summary>Created automatically. Moves queued shots onto the main thread.</summary>
    public class ShotEventDispatcher : MonoBehaviour
    {
        void Update() { ShotEvents.Drain(); }
    }
}
