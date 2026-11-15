using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using ArGolfCoach.Visualization;
using UnityEngine;

// Connects to the R10 bridge (connector/) and forwards each shot to the visuals.
// Editor: reaches the bridge on this Mac directly. Quest: through `adb reverse`, which the bridge sets up.
public class R10Receiver : MonoBehaviour
{
    public string url = "ws://127.0.0.1:8765";
    public string Status { get; private set; } = "connecting"; // bridge / R10 state

    [Serializable] class StatusMsg { public string type, state, error; public bool ready; }

    CancellationTokenSource cts;

    void OnEnable() { cts = new CancellationTokenSource(); _ = Run(cts.Token); }
    void OnDisable() => cts?.Cancel();

    async Task Run(CancellationToken token)
    {
        var buffer = new byte[16 * 1024];
        var message = new StringBuilder();

        while (!token.IsCancellationRequested)
        {
            try
            {
                using var ws = new ClientWebSocket();
                await ws.ConnectAsync(new Uri(url), token);
                Debug.Log("[R10] Connected to bridge");

                while (ws.State == WebSocketState.Open)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    message.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    if (!result.EndOfMessage) continue;
                    Handle(message.ToString());
                    message.Clear();
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception e) { SetStatus("bridge offline (" + e.Message + ")"); }

            message.Clear();
            try { await Task.Delay(2000, token); } catch { return; } // retry
        }
    }

    void Handle(string json)
    {
        if (json.Contains("\"type\":\"status\""))
        {
            var msg = JsonUtility.FromJson<StatusMsg>(json);
            SetStatus(msg.ready ? "R10 ready" : "R10 " + msg.state + (msg.error != null ? " (" + msg.error + ")" : ""));
            return;
        }
        // The bridge sends null for values the R10 didn't measure; JsonUtility needs plain values
        json = json.Replace("\"spinMeasured\":null", "\"spinMeasured\":false").Replace(":null", ":0");
        ShotEvents.PublishJson(json);
    }

    void SetStatus(string s)
    {
        if (s == Status) return;
        Status = s;
        Debug.Log("[R10] " + s);
    }
}
