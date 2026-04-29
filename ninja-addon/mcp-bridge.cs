#region Using declarations
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Code;
using NinjaTrader.Core;
using NinjaTrader.NinjaScript;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
#endregion

// AddOn lifecycle: opens a single ClientWebSocket to the MCP bridge, sends
// hello/heartbeat, parses inbound draw_zone/clear_zones, and re-emits them
// via static events. Companion indicator (McpBridgeRenderer) subscribes to
// those events and performs the actual chart drawing — an AddOn cannot
// render Draw.Rectangle itself because it has no chart context.
namespace NinjaTrader.NinjaScript.AddOns
{
	public class DrawZoneCommand
	{
		public string Id;
		public string Symbol;
		public double Proximal;
		public double Distal;
	}

	public class ClearZonesCommand
	{
		public string Symbol;
		public string Id; // null = clear all for symbol
	}

	public class McpBridge : NinjaTrader.NinjaScript.AddOnBase
	{
		private const int    HeartbeatIntervalMs = 10_000;
		private const int    ReconnectMinMs      = 1_000;
		private const int    ReconnectMaxMs      = 30_000;
		private const string ConfigFileName      = "bridge.config.json";

		public  static McpBridge Instance { get; private set; }

		public  static event Action<DrawZoneCommand>  DrawZoneReceived;
		public  static event Action<ClearZonesCommand> ClearZonesReceived;

		private CancellationTokenSource cts;
		private Task                    runner;
		private ClientWebSocket         socket;
		private readonly ConcurrentDictionary<string, byte> registeredSymbols
			= new ConcurrentDictionary<string, byte>();

		// Indicators register here so the AddOn can include them in `hello`.
		public void RegisterSymbol(string symbol)
		{
			if (string.IsNullOrEmpty(symbol)) return;
			registeredSymbols[symbol] = 1;
			Log("indicator registered symbol: " + symbol);
		}
		public void UnregisterSymbol(string symbol)
		{
			byte _;
			registeredSymbols.TryRemove(symbol, out _);
			Log("indicator unregistered symbol: " + symbol);
		}

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description = @"Bridge AddOn — connects to local MCP WebSocket and forwards draw/clear commands.";
				Name        = "McpBridge";
			}
			else if (State == State.Configure)
			{
				Instance = this;
				cts      = new CancellationTokenSource();
				runner   = Task.Run(() => RunAsync(cts.Token));
			}
			else if (State == State.Terminated)
			{
				try
				{
					if (cts != null) cts.Cancel();
					if (runner != null) runner.Wait(2_000);
				}
				catch (Exception ex) { Log("shutdown error: " + ex.Message); }
				finally
				{
					if (Instance == this) Instance = null;
				}
			}
		}

		// ---------- config ----------

		private class BridgeConfig
		{
			public string token;
			public string url;
		}

		private BridgeConfig LoadConfig()
		{
			var path = Path.Combine(Globals.UserDataDir, ConfigFileName);
			if (!File.Exists(path))
			{
				Log("config not found at " + path + " — create it with {\"token\":\"...\",\"url\":\"ws://127.0.0.1:9472\"}");
				return null;
			}
			try
			{
				var json = File.ReadAllText(path);
				var cfg  = JsonConvert.DeserializeObject<BridgeConfig>(json);
				if (cfg == null || string.IsNullOrEmpty(cfg.token) || string.IsNullOrEmpty(cfg.url))
				{
					Log("config at " + path + " missing token or url");
					return null;
				}
				return cfg;
			}
			catch (Exception ex)
			{
				Log("failed to parse config: " + ex.Message);
				return null;
			}
		}

		// ---------- main loop ----------

		private async Task RunAsync(CancellationToken ct)
		{
			var backoffMs = ReconnectMinMs;

			while (!ct.IsCancellationRequested)
			{
				var cfg = LoadConfig();
				if (cfg == null)
				{
					await DelayOrCancel(5_000, ct);
					continue;
				}

				try
				{
					using (socket = new ClientWebSocket())
					{
						socket.Options.SetRequestHeader("Authorization", "Bearer " + cfg.token);
						Log("connecting to " + cfg.url);
						await socket.ConnectAsync(new Uri(cfg.url), ct);
						Log("connected");
						backoffMs = ReconnectMinMs;

						await SendHelloAsync(socket, ct);

						var heartbeatTask = Task.Run(() => HeartbeatLoopAsync(socket, ct));
						await ReadLoopAsync(socket, ct);

						try { await heartbeatTask; } catch { /* expected on close */ }
					}
				}
				catch (OperationCanceledException) { /* shutting down */ }
				catch (Exception ex)
				{
					Log("connection error: " + ex.Message);
				}
				finally
				{
					socket = null;
				}

				if (ct.IsCancellationRequested) break;

				Log("reconnecting in " + backoffMs + "ms");
				await DelayOrCancel(backoffMs, ct);
				backoffMs = Math.Min(backoffMs * 2, ReconnectMaxMs);
			}

			Log("run loop exiting");
		}

		private static async Task DelayOrCancel(int ms, CancellationToken ct)
		{
			try { await Task.Delay(ms, ct); }
			catch (OperationCanceledException) { /* expected */ }
		}

		// ---------- send ----------

		private async Task SendHelloAsync(ClientWebSocket ws, CancellationToken ct)
		{
			var instruments = new System.Collections.Generic.List<string>(registeredSymbols.Keys);
			var hello = new
			{
				v           = 1,
				type        = "hello",
				ntVersion   = Globals.Version,
				instruments = instruments.ToArray(),
			};
			await SendJsonAsync(ws, JsonConvert.SerializeObject(hello), ct);
			Log("sent hello (" + instruments.Count + " instruments)");
		}

		private async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken ct)
		{
			var hb = JsonConvert.SerializeObject(new { v = 1, type = "heartbeat" });
			while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
			{
				await DelayOrCancel(HeartbeatIntervalMs, ct);
				if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;
				try { await SendJsonAsync(ws, hb, ct); }
				catch (Exception ex) { Log("heartbeat send failed: " + ex.Message); break; }
			}
		}

		private static readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
		private static async Task SendJsonAsync(ClientWebSocket ws, string json, CancellationToken ct)
		{
			var bytes = Encoding.UTF8.GetBytes(json);
			await sendLock.WaitAsync(ct);
			try
			{
				await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
			}
			finally { sendLock.Release(); }
		}

		// ---------- receive ----------

		private async Task ReadLoopAsync(ClientWebSocket ws, CancellationToken ct)
		{
			var buffer = new byte[16 * 1024];
			var sb     = new StringBuilder();

			while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
			{
				WebSocketReceiveResult result;
				try { result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct); }
				catch (OperationCanceledException) { break; }

				if (result.MessageType == WebSocketMessageType.Close)
				{
					Log("server closed: " + result.CloseStatus + " " + result.CloseStatusDescription);
					try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ack", CancellationToken.None); }
					catch { /* ignore */ }
					break;
				}

				sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
				if (result.EndOfMessage)
				{
					HandleMessage(sb.ToString());
					sb.Clear();
				}
			}
		}

		private void HandleMessage(string raw)
		{
			JObject obj;
			try { obj = JObject.Parse(raw); }
			catch (Exception ex) { Log("bad JSON: " + ex.Message); return; }

			var v    = (int?) obj["v"];
			var type = (string) obj["type"];
			if (v != 1 || string.IsNullOrEmpty(type))
			{
				Log("dropped message (v=" + v + ", type=" + type + ")");
				return;
			}

			switch (type)
			{
				case "hello_ack":
					Log("hello_ack: serverVersion=" + (string) obj["serverVersion"]);
					break;

				case "draw_zone":
				{
					var cmd = new DrawZoneCommand
					{
						Id       = (string) obj["id"],
						Symbol   = (string) obj["symbol"],
						Proximal = (double) obj["proximal"],
						Distal   = (double) obj["distal"],
					};
					Log("draw_zone " + cmd.Symbol + " id=" + cmd.Id + " p=" + cmd.Proximal + " d=" + cmd.Distal);
					var handler = DrawZoneReceived;
					if (handler != null) handler(cmd);
					break;
				}

				case "clear_zones":
				{
					var cmd = new ClearZonesCommand
					{
						Symbol = (string) obj["symbol"],
						Id     = (string) obj["id"], // may be null
					};
					Log("clear_zones " + cmd.Symbol + (cmd.Id != null ? " id=" + cmd.Id : " (all)"));
					var handler = ClearZonesReceived;
					if (handler != null) handler(cmd);
					break;
				}

				default:
					Log("unknown message type: " + type);
					break;
			}
		}

		// ---------- logging ----------

		private static void Log(string msg)
		{
			Output.Process("[McpBridge] " + msg, PrintTo.OutputTab1);
		}
	}
}
