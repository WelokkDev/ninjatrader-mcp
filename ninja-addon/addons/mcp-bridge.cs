#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Code;
using NinjaTrader.Core;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

// AddOn lifecycle: opens a single ClientWebSocket to the MCP bridge, sends
// hello/heartbeat, parses inbound draw_zone/clear_zones, and re-emits them
// via static events. Companion indicator (McpBridgeRenderer) subscribes to
// those events and performs the actual chart drawing — an AddOn cannot
// render Draw.Rectangle itself because it has no chart context.
//
// McpBridge is one partial class across every mcp-bridge*.cs file. Copy them
// all into AddOns\ together: a stale part still compiles.
namespace NinjaTrader.NinjaScript.AddOns
{
	public class DrawZoneCommand
	{
		public string    Id;
		public string    Symbol;
		public double    Proximal;
		public double    Distal;
		// Pre-converted to chart time (ET, DateTimeKind.Unspecified) by the AddOn
		// so the renderer doesn't need to know about timezones. Null = unspecified;
		// the renderer applies its bar-anchor fallback.
		public DateTime? FromTime;
		public DateTime? ToTime;
	}

	public class ClearZonesCommand
	{
		public string       Symbol; // null/empty = apply to every chart
		public string       Id;     // single-id form (legacy)
		public List<string> Ids;    // batch form; takes priority over Id when present
	}

	public class DrawCommand
	{
		public string    Id;
		public string    Symbol;
		public string    Kind;      // "rectangle" | "hline" | "vline" | "text" | "riskreward"
		public double    Proximal;  // rectangle
		public double    Distal;    // rectangle
		public double    Price;     // hline / text y
		public string    Text;      // text content
		public DateTime? FromTime;  // rectangle / hline / riskreward entry x (null => bar-anchor fallback)
		public DateTime? ToTime;    // rectangle / hline / riskreward end x   (null => current bar)
		public DateTime? AtTime;    // vline / text x
		public string    Color;     // style "#rrggbb" (null => default)
		public double?   Opacity;   // style 0..1 (null => default)
		public string    Label;     // style companion label (null => none)

		// riskreward. Nullable is load-bearing: which leg is present selects isStop.
		public double    Entry;
		public double?   Stop;
		public double?   Target;
		public double    Ratio;
	}

	// One retained drawing in the AddOn's persistence store. Exactly one of
	// Zone/Draw is non-null (legacy draw_zone vs generic draw).
	public class StoredDraw
	{
		public string          Id;
		public DrawZoneCommand Zone;
		public DrawCommand     Draw;
	}

	// One reply to a SendClientRequest call. Deliberately vocabulary-free: the
	// bridge routes it back by Id and knows nothing about what Kind means.
	public class ClientResponse
	{
		public string Id;
		public string Kind;
		public bool   Ok;
		public IDictionary<string, object> Payload; // null when !Ok
		public string Error;                        // null when Ok
	}

	public partial class McpBridge : NinjaTrader.NinjaScript.AddOnBase
	{
		private const int    HeartbeatIntervalMs = 10_000;
		private const int    ReconnectMinMs      = 1_000;
		private const int    ReconnectMaxMs      = 30_000;
		private const string ConfigFileName      = "bridge.config.json";

		public  static McpBridge Instance { get; private set; }

		public  static event Action<DrawZoneCommand>  DrawZoneReceived;
		public  static event Action<DrawCommand>      DrawReceived;
		public  static event Action<ClearZonesCommand> ClearZonesReceived;
		// Replies to SendClientRequest. Every subscriber sees every response —
		// filter on ClientResponse.Id (the value SendClientRequest returned) or
		// on Kind, exactly as the draw events filter on Symbol.
		public  static event Action<ClientResponse>   ClientResponseReceived;

		// Server-connection edges for companion NinjaScripts
		public  static event Action<bool>             ServerConnectionChanged;

		private volatile bool serverConnected;
		public  bool IsServerConnected { get { return serverConnected; } }

		// MaxJsonLength defaults to 2 MB and throws past it; a dense 1s session-day
		// (up to ~8 MB) blows through that. Raised well clear of the 100 MB ws cap.
		private static readonly JavaScriptSerializer Json =
			new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

		private CancellationTokenSource cts;
		private Task                    runner;
		private ClientWebSocket         socket;
		private readonly ConcurrentDictionary<string, byte> registeredSymbols
			= new ConcurrentDictionary<string, byte>();

		// Authoritative store of active drawings, keyed by symbol.
		private readonly Dictionary<string, List<StoredDraw>> drawStore
			= new Dictionary<string, List<StoredDraw>>(StringComparer.Ordinal);
		private readonly object drawStoreLock = new object();

		// Indicators register here so the AddOn can include them in `hello`.
		public void RegisterSymbol(string symbol)
		{
			if (string.IsNullOrEmpty(symbol)) return;
			if (registeredSymbols.TryAdd(symbol, 1))
				PushRoster();
			Log("indicator registered symbol: " + symbol);
		}
		public void UnregisterSymbol(string symbol)
		{
			byte _;
			if (registeredSymbols.TryRemove(symbol, out _))
				PushRoster();
			Log("indicator unregistered symbol: " + symbol);
		}

		// Companion-NinjaScript request seam. A private indicator hands over an
		// opaque kind + payload; this forwards it and the server's reply comes
		// back on ClientResponseReceived, correlated by the returned id.
		//
		// The AddOn deliberately understands NEITHER argument: no kind is
		// enumerated here and no payload key is inspected, so a companion can
		// define request types without any of its vocabulary landing in the
		// public bridge. Returns null when the socket is down — callers must
		// treat that as "ask again later", not as a silent success.
		public string SendClientRequest(string kind, IDictionary<string, object> payload)
		{
			if (string.IsNullOrEmpty(kind))
			{
				Log("SendClientRequest: empty kind ignored");
				return null;
			}
			if (socket == null || socket.State != WebSocketState.Open)
			{
				Log("SendClientRequest(" + kind + "): socket not open — dropped");
				return null;
			}

			var id = Guid.NewGuid().ToString("N");
			var msg = new Dictionary<string, object>
			{
				{ "v",       1 },
				{ "id",      id },
				{ "type",    "client_request" },
				{ "kind",    kind },
				{ "payload", payload ?? new Dictionary<string, object>() },
			};

			try
			{
				SendFireAndForget(Json.Serialize(msg), "client_request kind=" + kind + " id=" + id);
			}
			catch (Exception ex)
			{
				// Serialization is the realistic failure here (a payload value
				// JavaScriptSerializer can't handle). Fail closed with null so
				// the caller doesn't wait on a reply that will never come.
				Log("SendClientRequest(" + kind + ") failed: " + ex.Message);
				return null;
			}
			return id;
		}

		// Single writer for the connected flag so subscribers only ever see edges.
		private void SetServerConnected(bool value)
		{
			if (serverConnected == value) return;
			serverConnected = value;
			var handler = ServerConnectionChanged;
			if (handler == null) return;
			try { handler(value); }
			catch (Exception ex) { Log("ServerConnectionChanged subscriber failed: " + ex.Message); }
		}

		// draw persistence store — retained on the AddOn (which outlives chart
		// reloads) so the renderer can replay after a series/timeframe re-create.

		private void StoreUpsert(string symbol, StoredDraw entry)
		{
			if (string.IsNullOrEmpty(symbol) || entry == null || string.IsNullOrEmpty(entry.Id)) return;
			lock (drawStoreLock)
			{
				List<StoredDraw> list;
				if (!drawStore.TryGetValue(symbol, out list))
				{
					list = new List<StoredDraw>();
					drawStore[symbol] = list;
				}
				// Same id => replace in place (latest geometry wins); else append.
				for (int i = 0; i < list.Count; i++)
				{
					if (list[i].Id == entry.Id) { list[i] = entry; return; }
				}
				list.Add(entry);
			}
		}

		private void StoreClear(string symbol, string id, List<string> ids)
		{
			lock (drawStoreLock)
			{
				// Empty symbol = every symbol (mirrors the "all charts" clear semantics).
				var symbols = string.IsNullOrEmpty(symbol)
					? new List<string>(drawStore.Keys)
					: new List<string> { symbol };

				foreach (var s in symbols)
				{
					List<StoredDraw> list;
					if (!drawStore.TryGetValue(s, out list)) continue;

					if (ids != null && ids.Count > 0)
						list.RemoveAll(e => ids.Contains(e.Id));
					else if (!string.IsNullOrEmpty(id))
						list.RemoveAll(e => e.Id == id);
					else
						list.Clear();

					if (list.Count == 0) drawStore.Remove(s);
				}
			}
		}

		// Snapshot copy so the renderer can drain without holding the lock.
		public List<StoredDraw> GetDraws(string symbol)
		{
			lock (drawStoreLock)
			{
				List<StoredDraw> list;
				if (string.IsNullOrEmpty(symbol) || !drawStore.TryGetValue(symbol, out list))
					return new List<StoredDraw>();
				return new List<StoredDraw>(list);
			}
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
				Instance      = this;
				Connection.ConnectionStatusUpdate += OnConnectionStatusUpdate;
				Account.AccountStatusUpdate       += OnAccountStatusUpdate;
				cts           = new CancellationTokenSource();
				liveSendQueue = new BlockingCollection<string>(LiveSendQueueCapacity);
				liveSendWorker = Task.Run(() => LiveSendLoopAsync(cts.Token));
				runner        = Task.Run(() => RunAsync(cts.Token));
			}
			else if (State == State.Terminated)
			{
				try
				{
					Connection.ConnectionStatusUpdate -= OnConnectionStatusUpdate;
					Account.AccountStatusUpdate       -= OnAccountStatusUpdate;
					UnwireAllAccounts();
					if (cts != null) cts.Cancel();
					DisposeAllLiveSubs("addon terminating");
					if (liveSendQueue != null) liveSendQueue.CompleteAdding();
					if (runner != null) runner.Wait(2_000);
					if (liveSendWorker != null) liveSendWorker.Wait(2_000);
				}
				catch (Exception ex) { Log("shutdown error: " + ex.Message); }
				finally
				{
					if (Instance == this) Instance = null;
				}
			}
		}

		// After a feed reconnect, BarsRequests can silently stop updating —
		// dispose and recreate every live sub when a provider reconnects.
		private void OnConnectionStatusUpdate(object sender, ConnectionStatusEventArgs connectionStatusUpdate)
		{
			try { NoteConnectionError(connectionStatusUpdate); }
			catch (Exception ex) { Log("could not record a connection error: " + ex.Message); }

			try
			{
				if (connectionStatusUpdate.Status == ConnectionStatus.Connected
					&& connectionStatusUpdate.PreviousStatus != ConnectionStatus.Connected)
				{
					string connName = "?";
					try
					{
						if (connectionStatusUpdate.Connection != null
							&& connectionStatusUpdate.Connection.Options != null)
							connName = connectionStatusUpdate.Connection.Options.Name;
					}
					catch { /* name is best-effort */ }
					Log("provider (re)connected (" + connName + ": "
						+ connectionStatusUpdate.PreviousStatus + " -> Connected) — recreating live BarsRequests");
					Task.Run(() =>
					{
						RecreateAllLiveSubs();
						// Reconnect can add accounts / drop events — rewire + re-anchor.
						WireAccounts();
						SendPositionSync("provider reconnect");
					});
				}
			}
			catch (Exception ex)
			{
				Log("OnConnectionStatusUpdate error: " + ex.Message);
			}
		}

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
				var cfg  = Json.Deserialize<BridgeConfig>(json);
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

		// TradingHours startup verification.

		// Log every available NT8 template, then verify each TRADING_HOURS_MAP
		// value exists. The user cross-references the log and fixes it if wrong.
		private void LogAvailableTradingHours()
		{
			try
			{
				var sb = new StringBuilder();
				sb.Append("[startup] Available NT8 TradingHours templates:");
				int count = 0;
				foreach (var th in TradingHours.All)
				{
					if (th == null) continue;
					sb.Append(" '").Append(th.Name).Append("'");
					count++;
				}
				if (count == 0) sb.Append(" <none>");
				Log(sb.ToString());

				foreach (var kvp in TRADING_HOURS_MAP)
				{
					var nt8Name = kvp.Value;
					var found = false;
					foreach (var th in TradingHours.All)
					{
						if (th == null) continue;
						if (string.Equals(th.Name, nt8Name, StringComparison.Ordinal))
						{
							found = true;
							break;
						}
					}
					if (found)
					{
						Log("[startup] verified mapping: " + kvp.Key + " → '" + nt8Name + "' (exists in NT8)");
					}
					else
					{
						Log("[startup] WARNING: mapping target NOT FOUND in NT8: "
							+ kvp.Key + " → '" + nt8Name
							+ "' — name this install's template on the server (nt8TradingHours)");
					}
				}
			}
			catch (Exception ex)
			{
				Log("[startup] failed to enumerate TradingHours.All: " + ex.Message);
			}
		}

		// main loop

		private async Task RunAsync(CancellationToken ct)
		{
			LogAvailableTradingHours();
			try { WireAccounts(); }
			catch (Exception ex) { Log("initial account wiring failed: " + ex.Message); }

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
						instrumentCache.Clear();
						lastRebindSessionDate = null;
						MaybeRebindOnSessionChange("hello");

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
					SetServerConnected(false);
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

		// send

		// Write ops advertised in hello `caps` so the server fails fast on deploy
		// skew (new server, old AddOn) instead of timing out.
		private static readonly string[] WriteCaps = new[]
		{
			"place_order", "place_oco", "cancel_order", "cancel_all", "flatten", "change_order",
			"set_indicator_params", "request_ticks.v2", "connect_feed",
		};

		private async Task SendHelloAsync(ClientWebSocket ws, CancellationToken ct)
		{
			var instruments = new List<string>(registeredSymbols.Keys);
			var hello = new Dictionary<string, object>
			{
				{ "v",           1 },
				{ "type",        "hello" },
				{ "ntVersion",   "NT8" },
				{ "instruments", instruments.ToArray() },
				{ "timeZone",    GetConfiguredTimeZoneId() },
				{ "caps",        WriteCaps },
			};
			await SendJsonAsync(ws, Json.Serialize(hello), ct);
			Log("sent hello (" + instruments.Count + " instruments, " + WriteCaps.Length + " caps)");
		}

		// Bars are stamped in NT8's configured timezone; the server warns if it
		// isn't Eastern. Fully reflective so it compiles on any NT8 build.
		private static TimeZoneInfo GetConfiguredTimeZone()
		{
			try
			{
				var goProp = typeof(Globals).GetProperty("GeneralOptions",
					System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
				var go = goProp != null ? goProp.GetValue(null, null) : null;
				if (go != null)
				{
					var p = go.GetType().GetProperty("TimeZoneInfo");
					return p != null ? p.GetValue(go, null) as TimeZoneInfo : null;
				}
			}
			catch (Exception) { /* unreadable */ }
			return null;
		}

		private static string GetConfiguredTimeZoneId()
		{
			var tz = GetConfiguredTimeZone();
			return tz != null ? tz.Id : "unknown(local:" + TimeZoneInfo.Local.Id + ")";
		}

		// Push the renderer roster on change so the server's known-instruments list
		// stays live rather than a connect-time snapshot. Fire-and-forget; roster
		// changes made while disconnected are covered by the next hello.
		private void PushRoster()
		{
			var instruments = new List<string>(registeredSymbols.Keys);
			var msg = new Dictionary<string, object>
			{
				{ "v",           1 },
				{ "type",        "instruments_update" },
				{ "instruments", instruments.ToArray() },
			};
			SendFireAndForget(Json.Serialize(msg),
				"instruments_update (" + instruments.Count + " instruments)");
		}

		private async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken ct)
		{
			var hb = Json.Serialize(new Dictionary<string, object>
			{
				{ "v",    1 },
				{ "type", "heartbeat" },
			});
			while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
			{
				await DelayOrCancel(HeartbeatIntervalMs, ct);
				if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;
				MaybeRebindOnSessionChange("session");
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

		// receive

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

		private static string GetString(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			return v.ToString();
		}

		private static int? GetInt(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			try { return Convert.ToInt32(v); } catch { return null; }
		}

		private static long? GetLong(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			try { return Convert.ToInt64(v); } catch { return null; }
		}

		private static bool? GetBool(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			if (v is bool) return (bool) v;
			try { return Convert.ToBoolean(v); } catch { return null; }
		}

		private static double GetDouble(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return 0.0;
			return Convert.ToDouble(v);
		}

		// GetDouble collapses a missing key to 0.0, which is wrong wherever the
		// key's PRESENCE is the signal — e.g. riskreward's stop/target picking isStop.
		private static double? GetNullableDouble(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			try { return Convert.ToDouble(v); } catch { return null; }
		}

		// JavaScriptSerializer deserializes JSON arrays as object[] (or ArrayList in
		// some configurations); accept either and stringify each element.
		private static List<string> GetStringArray(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			var enumerable = v as System.Collections.IEnumerable;
			if (enumerable == null) return null;
			var list = new List<string>();
			foreach (var item in enumerable)
			{
				if (item == null) continue;
				var s = item.ToString();
				if (!string.IsNullOrEmpty(s)) list.Add(s);
			}
			return list.Count > 0 ? list : null;
		}

		private static IDictionary<string, object> GetDict(IDictionary<string, object> obj, string key)
		{
			object v;
			if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
			return v as IDictionary<string, object>;
		}

		private void HandleMessage(string raw)
		{
			Dictionary<string, object> obj;
			try { obj = Json.Deserialize<Dictionary<string, object>>(raw); }
			catch (Exception ex) { Log("bad JSON: " + ex.Message); return; }

			if (obj == null) { Log("dropped message (null)"); return; }

			var v    = GetInt(obj, "v");
			var type = GetString(obj, "type");
			if (v != 1 || string.IsNullOrEmpty(type))
			{
				Log("dropped message (v=" + v + ", type=" + type + ")");
				return;
			}

			switch (type)
			{
				case "hello_ack":
					Log("hello_ack: serverVersion=" + GetString(obj, "serverVersion"));
					SetServerConnected(true);
					break;

				case "draw_zone":
				{
					var fromTs = GetLong(obj, "fromTs");
					var toTs   = GetLong(obj, "toTs");
					DateTime? fromTime = null;
					DateTime? toTime   = null;
					try
					{
						if (fromTs.HasValue) fromTime = UnixSecondsToExchangeTime(fromTs.Value);
						if (toTs.HasValue)   toTime   = UnixSecondsToExchangeTime(toTs.Value);
					}
					catch (Exception ex)
					{
						Log("draw_zone bad timestamp: " + ex.Message + " — falling back to bar anchor");
						fromTime = null;
						toTime   = null;
					}

					var cmd = new DrawZoneCommand
					{
						Id       = GetString(obj, "id"),
						Symbol   = GetString(obj, "symbol"),
						Proximal = GetDouble(obj, "proximal"),
						Distal   = GetDouble(obj, "distal"),
						FromTime = fromTime,
						ToTime   = toTime,
					};
					Log("draw_zone " + cmd.Symbol + " id=" + cmd.Id
						+ " p=" + cmd.Proximal + " d=" + cmd.Distal
						+ " from=" + (fromTime.HasValue ? fromTime.Value.ToString("yyyy-MM-dd HH:mm") : "<bar-anchor>")
						+ " to="   + (toTime.HasValue   ? toTime.Value.ToString("yyyy-MM-dd HH:mm")   : "<current-bar>"));
					StoreUpsert(cmd.Symbol, new StoredDraw { Id = cmd.Id, Zone = cmd });
					var handler = DrawZoneReceived;
					if (handler != null) handler(cmd);
					break;
				}

				case "draw":
				{
					var shape = GetDict(obj, "shape");
					var style = GetDict(obj, "style");
					if (shape == null) { Log("draw: missing shape"); break; }
					var kind = GetString(shape, "kind");

					var fromTs = GetLong(shape, "fromTs");
					var toTs   = GetLong(shape, "toTs");
					var ts     = GetLong(shape, "ts");
					DateTime? fromTime = null, toTime = null, atTime = null;
					try
					{
						if (fromTs.HasValue) fromTime = UnixSecondsToExchangeTime(fromTs.Value);
						if (toTs.HasValue)   toTime   = UnixSecondsToExchangeTime(toTs.Value);
						if (ts.HasValue)     atTime   = UnixSecondsToExchangeTime(ts.Value);
					}
					catch (Exception ex) { Log("draw bad timestamp: " + ex.Message); fromTime = toTime = atTime = null; }

					var cmd = new DrawCommand
					{
						Id       = GetString(obj, "id"),
						Symbol   = GetString(obj, "symbol"),
						Kind     = kind,
						Proximal = GetDouble(shape, "proximal"),
						Distal   = GetDouble(shape, "distal"),
						Price    = GetDouble(shape, "price"),
						Text     = GetString(shape, "text"),
						FromTime = fromTime,
						ToTime   = toTime,
						AtTime   = atTime,
						Color    = style != null ? GetString(style, "color") : null,
						Opacity  = style != null && style.ContainsKey("opacity") ? (double?) GetDouble(style, "opacity") : null,
						Label    = style != null ? GetString(style, "label") : null,
						Entry    = GetDouble(shape, "entry"),
						Stop     = GetNullableDouble(shape, "stop"),
						Target   = GetNullableDouble(shape, "target"),
						Ratio    = GetDouble(shape, "ratio"),
					};

					// Rendering a legless riskreward would anchor the derived leg at 0.
					if (kind == "riskreward" && !cmd.Stop.HasValue && !cmd.Target.HasValue)
					{
						Log("draw: riskreward id=" + cmd.Id + " has neither stop nor target — ignored");
						break;
					}

					Log("draw " + cmd.Symbol + " id=" + cmd.Id + " kind=" + cmd.Kind);
					StoreUpsert(cmd.Symbol, new StoredDraw { Id = cmd.Id, Draw = cmd });
					var dh = DrawReceived;
					if (dh != null) dh(cmd);
					break;
				}

				case "clear_zones":
				{
					var cmd = new ClearZonesCommand
					{
						Symbol = GetString(obj, "symbol"),
						Id     = GetString(obj, "id"),
						Ids    = GetStringArray(obj, "ids"),
					};
					var symbolDesc = string.IsNullOrEmpty(cmd.Symbol) ? "<all-charts>" : cmd.Symbol;
					string idDesc;
					if (cmd.Ids != null && cmd.Ids.Count > 0) idDesc = " ids=[" + string.Join(",", cmd.Ids.ToArray()) + "]";
					else if (!string.IsNullOrEmpty(cmd.Id))   idDesc = " id=" + cmd.Id;
					else                                       idDesc = " (all)";
					Log("clear_zones " + symbolDesc + idDesc);
					StoreClear(cmd.Symbol, cmd.Id, cmd.Ids);
					var handler = ClearZonesReceived;
					if (handler != null) handler(cmd);
					break;
				}

				case "client_response":
				{
					var ok = GetBool(obj, "ok");
					var resp = new ClientResponse
					{
						Id      = GetString(obj, "id"),
						Kind    = GetString(obj, "kind"),
						Ok      = ok.HasValue && ok.Value,
						Payload = GetDict(obj, "payload"),
						Error   = GetString(obj, "error"),
					};
					Log("client_response kind=" + resp.Kind + " id=" + resp.Id
						+ (resp.Ok ? " ok" : " FAILED: " + resp.Error));
					var clientHandler = ClientResponseReceived;
					if (clientHandler != null) clientHandler(resp);
					break;
				}

				case "request_candles":
					HandleRequestCandles(obj);
					break;

				// Off the read thread: ResolveInstrument can block for seconds
				// and would starve heartbeats.
				case "subscribe_bars":
				{
					var o = obj;
					Task.Run(() => HandleSubscribeBars(o));
					break;
				}

				case "unsubscribe_bars":
				{
					var o = obj;
					Task.Run(() => HandleUnsubscribeBars(o));
					break;
				}

				case "resolve_instrument":
					HandleResolveInstrument(obj);
					break;

				// Off the read thread: the account scan and instrument lookup can block.
				case "request_ticks":
				{
					var o = obj;
					Task.Run(() => HandleRequestTicks(o));
					break;
				}

				case "request_session_calendar":
					HandleRequestSessionCalendar(obj);
					break;

				case "request_open_charts":
					HandleRequestOpenCharts(obj);
					break;

				case "navigate_chart":
					HandleNavigateChart(obj);
					break;

				case "request_drawings":
					HandleRequestDrawings(obj);
					break;

				case "request_chart_indicators":
					HandleRequestChartIndicators(obj);
					break;

				case "request_indicator_values":
					HandleRequestIndicatorValues(obj);
					break;

				case "request_set_indicator_params":
					HandleRequestSetIndicatorParams(obj);
					break;

				// Off the read thread: snapshots enumerate NT collections and
				// must never starve heartbeats.
				case "request_positions":
				{
					var o = obj;
					Task.Run(() => HandleRequestPositions(o));
					break;
				}

				case "subscribe_positions":
				{
					var o = obj;
					Task.Run(() => HandleSubscribePositions(o));
					break;
				}

				case "unsubscribe_positions":
				{
					var o = obj;
					Task.Run(() => HandleUnsubscribePositions(o));
					break;
				}

				// Off the read thread: ResolveInstrument can block and Submit
				// must never stall heartbeats.
				case "place_order":
				{
					var o = obj;
					Task.Run(() => HandlePlaceOrder(o));
					break;
				}

				// Off the read thread: NT8 account calls can block and must
				// never stall heartbeats.
				case "place_oco":
				{
					var o = obj;
					Task.Run(() => HandlePlaceOco(o));
					break;
				}

				case "cancel_order":
				{
					var o = obj;
					Task.Run(() => HandleCancelOrder(o));
					break;
				}

				case "cancel_all":
				{
					var o = obj;
					Task.Run(() => HandleCancelAll(o));
					break;
				}

				case "flatten":
				{
					var o = obj;
					Task.Run(() => HandleFlatten(o));
					break;
				}

				case "change_order":
				{
					var o = obj;
					Task.Run(() => HandleChangeOrder(o));
					break;
				}

				// Off the read thread: it waits up to a minute or more for NT8 to connect.
				case "connect_feed":
				{
					var o = obj;
					Task.Run(() => HandleConnectFeed(o));
					break;
				}

				default:
					Log("unknown message type: " + type);
					break;
			}
		}

		private void SendErrorResponse(string id, string message)
		{
			SendErrorResponse(id, message, null);
		}

		// `code` is an optional machine-readable classifier (write-path ops only).
		// Non-order rejections pass null, so the key is omitted on the wire.
		private void SendErrorResponse(string id, string message, string code)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",       1 },
				{ "id",      id },
				{ "type",    "error" },
				{ "message", message },
			};
			if (!string.IsNullOrEmpty(code)) payload["code"] = code;
			SendFireAndForget(Json.Serialize(payload),
				"error id=" + id + " msg=" + message + (string.IsNullOrEmpty(code) ? "" : " code=" + code));
		}

		private void SendFireAndForget(string json, string logTag)
		{
			var ws = socket;
			if (ws == null || ws.State != WebSocketState.Open)
			{
				Log("cannot send (" + logTag + "): socket not open");
				return;
			}
			Task.Run(async () =>
			{
				try
				{
					await SendJsonAsync(ws, json, CancellationToken.None);
					Log("sent " + logTag);
				}
				catch (Exception ex)
				{
					Log("send failed (" + logTag + "): " + ex.Message);
				}
			});
		}

		// logging

		private static void Log(string msg)
		{
			Output.Process("[McpBridge] " + msg, PrintTo.OutputTab1);
		}
	}
}
