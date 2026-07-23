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
		public string    Kind;      // "rectangle" | "hline" | "vline" | "text"
		public double    Proximal;  // rectangle
		public double    Distal;    // rectangle
		public double    Price;     // hline / text y
		public string    Text;      // text content
		public DateTime? FromTime;  // rectangle / hline start (null => bar-anchor fallback)
		public DateTime? ToTime;    // rectangle / hline end   (null => current bar)
		public DateTime? AtTime;    // vline / text x
		public string    Color;     // style "#rrggbb" (null => default)
		public double?   Opacity;   // style 0..1 (null => default)
		public string    Label;     // style companion label (null => none)
	}

	// One retained drawing in the AddOn's persistence store. Exactly one of
	// Zone/Draw is non-null (legacy draw_zone vs generic draw).
	public class StoredDraw
	{
		public string          Id;
		public DrawZoneCommand Zone;
		public DrawCommand     Draw;
	}

	public class McpBridge : NinjaTrader.NinjaScript.AddOnBase
	{
		private const int    HeartbeatIntervalMs = 10_000;
		private const int    ReconnectMinMs      = 1_000;
		private const int    ReconnectMaxMs      = 30_000;
		private const string ConfigFileName      = "bridge.config.json";

		public  static McpBridge Instance { get; private set; }

		public  static event Action<DrawZoneCommand>  DrawZoneReceived;
		public  static event Action<DrawCommand>      DrawReceived;
		public  static event Action<ClearZonesCommand> ClearZonesReceived;

		private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

		// Raw timeframes this bridge will serve via request_candles. Keep in
		// sync with RAW_TIMEFRAMES in the server's src/core/constants.ts.
		private static readonly HashSet<string> ALLOWED_RAW_TIMEFRAMES =
			new HashSet<string>(StringComparer.Ordinal) { "15s", "5m", "15m" };

		private static readonly Dictionary<string, string> TRADING_HOURS_MAP =
			new Dictionary<string, string>(StringComparer.Ordinal)
		{
			{ "cme_us_index_futures_eth", "CME US Index Futures ETH" },
			// NT8 ships one combined template for NYMEX energy + COMEX metals.
			{ "nymex_energy_eth",         "Nymex Metals - Energy ETH" },
			{ "comex_metals_eth",         "Nymex Metals - Energy ETH" },
		};

		private CancellationTokenSource cts;
		private Task                    runner;
		private ClientWebSocket         socket;
		private readonly ConcurrentDictionary<string, byte> registeredSymbols
			= new ConcurrentDictionary<string, byte>();

		// Authoritative store of active drawings, keyed by symbol.
		private readonly Dictionary<string, List<StoredDraw>> drawStore
			= new Dictionary<string, List<StoredDraw>>(StringComparer.Ordinal);
		private readonly object drawStoreLock = new object();

		// ---------- live bar subscription state ----------

		private const int LiveSeedBarsBack      = 30;   // enough to establish the index baseline
		private const int LiveSendQueueCapacity = 2048; // beyond this, bars drop (TS-side heal recovers)
		private const int BackfillThresholdBars = 2;    // older than 2 bar-widths at emit => backfill:true

		private class LiveSub
		{
			public string      Key;        // symbol + "|" + timeframe
			public string      Symbol;     // roster symbol, e.g. "MNQ"
			public string      Timeframe;  // "15s" | "5m" | "15m"
			public string      TradingHoursTemplate; // internal key, for reconnect re-resolution
			public int         TfSeconds;
			public Instrument  Instrument;
			public BarsRequest Request;
			// Per-sub closure (no reliance on Update's undocumented sender);
			// kept for detach.
			public EventHandler<BarsUpdateEventArgs> Handler;
			// subscribe_bars ids awaiting the seed callback's verdict.
			public List<string> PendingAckIds = new List<string>();
			public int         LastMaxIndex = -1;
			public bool        Seeded;
			public long        Seq;        // monotonic per sub; survives feed reconnects
		}

		private readonly Dictionary<string, LiveSub> liveSubs
			= new Dictionary<string, LiveSub>(StringComparer.Ordinal);
		private readonly object liveLock = new object();
		// Serializes RecreateAllLiveSubs (two providers reconnecting at once).
		private readonly object recreateGate = new object();

		// Ordered single-writer queue for live sends — the fire-and-forget path
		// does not preserve FIFO, and seq-carrying bars must never reorder.
		private BlockingCollection<string> liveSendQueue;
		private Task liveSendWorker;

		// ---------- position tracking state ----------
		//
		// Read-only account observation — never creates, changes, or cancels
		// orders. posLock guards the wired set, streaming flag, and the seq
		// shared by position_event/position_sync (drop detection + ordering).

		private class AccountHandlers
		{
			public EventHandler<PositionEventArgs>  OnPosition;
			public EventHandler<OrderEventArgs>     OnOrder;
			public EventHandler<ExecutionEventArgs> OnExecution;
		}

		private readonly Dictionary<Account, AccountHandlers> wiredAccounts
			= new Dictionary<Account, AccountHandlers>();
		private readonly object posLock = new object();
		private bool positionsStreaming;
		private long positionSeq;

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

		// ---------- draw persistence store ----------
		// Retain active drawings on the AddOn (which outlives chart reloads) so the
		// renderer can replay them after a data-series/timeframe change re-creates it.

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

		// ---------- TradingHours startup verification ----------

		// Log every NT8 TradingHours template available on this install,
		// then verify each value in TRADING_HOURS_MAP exists. Run once at
		// AddOn startup (from RunAsync). The user cross-references the log
		// to confirm the mapping is correct for their NT8 version, and
		// updates TRADING_HOURS_MAP if any guesses are wrong.
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
							+ "' — fix TRADING_HOURS_MAP in mcp-bridge.cs");
					}
				}
			}
			catch (Exception ex)
			{
				Log("[startup] failed to enumerate TradingHours.All: " + ex.Message);
			}
		}

		// ---------- main loop ----------

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
			var instruments = new List<string>(registeredSymbols.Keys);
			var hello = new Dictionary<string, object>
			{
				{ "v",           1 },
				{ "type",        "hello" },
				{ "ntVersion",   "NT8" },
				{ "instruments", instruments.ToArray() },
				{ "timeZone",    GetConfiguredTimeZoneId() },
			};
			await SendJsonAsync(ws, Json.Serialize(hello), ct);
			Log("sent hello (" + instruments.Count + " instruments)");
		}

		// Bars are stamped in NT8's configured timezone; the server warns if it
		// isn't Eastern. Fully reflective so it compiles on any NT8 build.
		private static string GetConfiguredTimeZoneId()
		{
			try
			{
				var goProp = typeof(Globals).GetProperty("GeneralOptions",
					System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
				var go = goProp != null ? goProp.GetValue(null, null) : null;
				if (go != null)
				{
					var p = go.GetType().GetProperty("TimeZoneInfo");
					var tz = p != null ? p.GetValue(go, null) as TimeZoneInfo : null;
					if (tz != null) return tz.Id;
				}
			}
			catch (Exception) { /* fall through to the OS fallback */ }
			return "unknown(local:" + TimeZoneInfo.Local.Id + ")";
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
					};
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

				case "request_session_calendar":
					HandleRequestSessionCalendar(obj);
					break;

				case "request_open_charts":
					HandleRequestOpenCharts(obj);
					break;

				case "navigate_chart":
					HandleNavigateChart(obj);
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

				default:
					Log("unknown message type: " + type);
					break;
			}
		}

		// ---------- request_candles ----------

		private static readonly DateTime UnixEpoch =
			new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

		// CME RTH bar times come back in US Eastern. Windows id "Eastern Standard Time"
		// covers DST automatically.
		private static readonly TimeZoneInfo EasternTz =
			TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

		private static DateTime UnixSecondsToExchangeTime(long unix)
		{
			var utc = UnixEpoch.AddSeconds(unix);
			var et  = TimeZoneInfo.ConvertTimeFromUtc(utc, EasternTz);
			return DateTime.SpecifyKind(et, DateTimeKind.Unspecified);
		}

		private static long ExchangeTimeToUnixSeconds(DateTime exchangeTime)
		{
			var unspecified = DateTime.SpecifyKind(exchangeTime, DateTimeKind.Unspecified);
			var utc         = TimeZoneInfo.ConvertTimeToUtc(unspecified, EasternTz);
			return (long) (utc - UnixEpoch).TotalSeconds;
		}

		private static string DescribeInstrument(Instrument inst)
		{
			if (inst == null) return "<null>";
			try
			{
				var master  = inst.MasterInstrument != null ? inst.MasterInstrument.Name : "?";
				var expiry  = inst.Expiry == DateTime.MinValue ? "n/a" : inst.Expiry.ToString("yyyy-MM-dd");
				return inst.FullName + " (master=" + master + ", expiry=" + expiry + ")";
			}
			catch (Exception ex)
			{
				return "<describe-failed: " + ex.Message + ">";
			}
		}

		private static bool IsActiveContract(Instrument inst)
		{
			// Reject NT's master/template record (sentinel expiry like 1900-01-01)
			// and anything already expired. Only real, tradable, non-expired
			// contracts have bars to return.
			if (inst == null) return false;
			return inst.Expiry > DateTime.Today;
		}

		private Instrument ResolveInstrument(string symbol)
		{
			if (string.IsNullOrEmpty(symbol)) return null;

			// 1) Direct lookup — only accept if it resolves to a real, non-expired contract.
			//    For master symbols like "NQ", NT typically returns the template (expiry 1900-01-01),
			//    which we must reject; for full names like "NQ 06-26" this returns the real contract.
			try
			{
				var inst = Instrument.GetInstrument(symbol);
				if (IsActiveContract(inst))
				{
					Log("ResolveInstrument: GetInstrument('" + symbol + "') → " + DescribeInstrument(inst));
					return inst;
				}
				Log("ResolveInstrument: GetInstrument('" + symbol + "') returned "
					+ (inst == null ? "null" : "template/expired (" + DescribeInstrument(inst) + ")")
					+ "; searching for active front-month contract");
			}
			catch (Exception ex)
			{
				Log("GetInstrument threw for '" + symbol + "': " + ex.Message);
			}

			// 2) Scan Instrument.All for the soonest non-expired contract whose master matches.
			try
			{
				Instrument frontMonth = null;
				int scanned = 0, candidates = 0;
				foreach (var i in Instrument.All)
				{
					scanned++;
					if (i == null || i.MasterInstrument == null) continue;
					if (!string.Equals(i.MasterInstrument.Name, symbol, StringComparison.OrdinalIgnoreCase)) continue;
					if (!IsActiveContract(i)) continue;
					candidates++;
					if (frontMonth == null || i.Expiry < frontMonth.Expiry) frontMonth = i;
				}
				Log("ResolveInstrument: scanned " + scanned + " instruments, "
					+ candidates + " active contract candidates for '" + symbol + "'");
				if (frontMonth != null)
				{
					Log("ResolveInstrument: front-month from scan → " + DescribeInstrument(frontMonth));
					return frontMonth;
				}
			}
			catch (Exception ex)
			{
				Log("Instrument.All scan threw: " + ex.Message);
			}

			// 3) Compute candidate "<symbol> MM-YY" strings forward by month and ask NT
			//    directly. Works for any futures cycle (NQ quarterly, CL monthly, GC bi-monthly)
			//    because non-existent contracts return null and we just skip them.
			try
			{
				var today = DateTime.Today;
				for (int offset = 0; offset < 24; offset++)
				{
					var d = today.AddMonths(offset);
					var cand = string.Format("{0} {1:D2}-{2:D2}", symbol, d.Month, d.Year % 100);
					Instrument inst = null;
					try { inst = Instrument.GetInstrument(cand); }
					catch (Exception ex) { Log("ResolveInstrument: GetInstrument('" + cand + "') threw: " + ex.Message); continue; }
					if (IsActiveContract(inst))
					{
						Log("ResolveInstrument: computed contract '" + cand + "' → " + DescribeInstrument(inst));
						return inst;
					}
				}
				Log("ResolveInstrument: no active contract found for '" + symbol + "' after 24 monthly probes");
			}
			catch (Exception ex)
			{
				Log("Computed-contract fallback threw: " + ex.Message);
			}

			return null;
		}

		private static string DescribeProviderState()
		{
			try
			{
				var conns      = Connection.Connections;
				var total      = 0;
				var connected  = 0;
				var sb         = new StringBuilder();
				if (conns != null)
				{
					foreach (var c in conns)
					{
						if (c == null) continue;
						total++;
						string name;
						try { name = c.Options != null ? c.Options.Name : "?"; }
						catch { name = "?"; }
						var status = c.Status.ToString();
						if (c.Status == ConnectionStatus.Connected) connected++;
						if (sb.Length > 0) sb.Append(", ");
						sb.Append(name).Append("/").Append(status);
					}
				}
				return "totalConnections=" + total + " connected=" + connected
					+ " [" + sb.ToString() + "]";
			}
			catch (Exception ex)
			{
				return "<provider-state-failed: " + ex.Message + ">";
			}
		}

		// Best-effort name of the feed currently serving bars, biased so the
		// Simulated Data Feed wins when connected: the server rejects sim bars,
		// so over-reporting "sim" only forces a harmless refetch while
		// under-reporting would poison the cache. Phase 1 needs just the
		// sim/real split; Phase 2 refines the real-provider name.
		private static string ClassifyDataSource()
		{
			try
			{
				var conns = Connection.Connections;
				var firstReal = "";
				if (conns != null)
				{
					foreach (var c in conns)
					{
						if (c == null) continue;
						if (c.Status != ConnectionStatus.Connected) continue;
						string name;
						try { name = c.Options != null ? c.Options.Name : ""; }
						catch { name = ""; }
						if (string.Equals(name, "Simulated Data Feed",
							StringComparison.OrdinalIgnoreCase))
							return "Simulated Data Feed";
						if (firstReal.Length == 0 && name.Length > 0) firstReal = name;
					}
				}
				return firstReal;
			}
			catch (Exception ex)
			{
				Log("ClassifyDataSource failed: " + ex.Message);
				return "";
			}
		}

		// Serialize a template's NT8-declared holidays (fully closed) and
		// partial holidays (early close / late begin). NT8 exposes dates
		// only, never times — the server observes those from real fetches.
		private void HandleRequestSessionCalendar(IDictionary<string, object> obj)
		{
			var id                   = GetString(obj, "id");
			var tradingHoursTemplate = GetString(obj, "tradingHoursTemplate");

			if (string.IsNullOrEmpty(id))
			{
				Log("request_session_calendar missing id; dropping");
				return;
			}
			if (string.IsNullOrEmpty(tradingHoursTemplate))
			{
				SendErrorResponse(id, "request_session_calendar missing required field: tradingHoursTemplate");
				return;
			}

			string nt8TemplateName;
			if (!TRADING_HOURS_MAP.TryGetValue(tradingHoursTemplate, out nt8TemplateName))
			{
				SendErrorResponse(id, "Unknown tradingHoursTemplate: '" + tradingHoursTemplate
					+ "'. Add the entry to TRADING_HOURS_MAP in mcp-bridge.cs.");
				return;
			}

			TradingHours nt8TradingHours;
			try
			{
				nt8TradingHours = TradingHours.Get(nt8TemplateName);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "TradingHours.Get('" + nt8TemplateName + "') threw: " + ex.Message);
				return;
			}
			if (nt8TradingHours == null)
			{
				SendErrorResponse(id, "NT8 has no TradingHours template named '" + nt8TemplateName + "'");
				return;
			}

			var holidays = new List<object>();
			if (nt8TradingHours.Holidays != null)
			{
				foreach (var kvp in nt8TradingHours.Holidays)
				{
					holidays.Add(new Dictionary<string, object>
					{
						{ "date",        kvp.Key.ToString("yyyy-MM-dd") },
						{ "description", kvp.Value ?? "" },
					});
				}
			}

			var partialHolidays = new List<object>();
			if (nt8TradingHours.PartialHolidays != null)
			{
				foreach (var kvp in nt8TradingHours.PartialHolidays)
				{
					var partial = kvp.Value;
					partialHolidays.Add(new Dictionary<string, object>
					{
						{ "date",         kvp.Key.ToString("yyyy-MM-dd") },
						{ "isEarlyClose", partial != null && partial.IsEarlyEnd },
						{ "isLateBegin",  partial != null && partial.IsLateBegin },
						{ "description",  partial != null && partial.Description != null ? partial.Description : "" },
					});
				}
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",               1 },
				{ "id",              id },
				{ "type",            "session_calendar_response" },
				{ "holidays",        holidays },
				{ "partialHolidays", partialHolidays },
			};
			SendFireAndForget(Json.Serialize(payload),
				"session_calendar_response id=" + id
				+ " holidays=" + holidays.Count + " partial=" + partialHolidays.Count);
		}

		// ---------- shared TF / trading-hours resolution ----------
		// One implementation for request_candles and subscribe_bars — the two
		// paths cannot drift.

		private static bool TryResolveBarsPeriod(string timeframe,
			out BarsPeriodType periodType, out int periodValue,
			out string resolvedTimeframe, out string error)
		{
			periodType        = BarsPeriodType.Minute;
			periodValue       = 15;
			resolvedTimeframe = "15m";
			error             = null;
			if (string.IsNullOrEmpty(timeframe)) return true; // request_candles default
			if (!ALLOWED_RAW_TIMEFRAMES.Contains(timeframe))
			{
				error = "Unsupported timeframe: '" + timeframe
					+ "'. Supported raw TFs: " + string.Join(", ", ALLOWED_RAW_TIMEFRAMES) + ".";
				return false;
			}
			var unit = timeframe[timeframe.Length - 1];
			int n;
			if (!int.TryParse(timeframe.Substring(0, timeframe.Length - 1), out n) || n <= 0)
			{
				error = "Malformed timeframe: '" + timeframe + "'";
				return false;
			}
			periodType        = unit == 's' ? BarsPeriodType.Second : BarsPeriodType.Minute;
			periodValue       = n;
			resolvedTimeframe = timeframe;
			return true;
		}

		private static bool TryResolveTradingHours(string tradingHoursTemplate,
			out TradingHours tradingHours, out string nt8TemplateName, out string error)
		{
			tradingHours    = null;
			error           = null;
			if (!TRADING_HOURS_MAP.TryGetValue(tradingHoursTemplate, out nt8TemplateName))
			{
				var knownKeys = new StringBuilder();
				foreach (var k in TRADING_HOURS_MAP.Keys)
				{
					if (knownKeys.Length > 0) knownKeys.Append(", ");
					knownKeys.Append(k);
				}
				error = "Unknown tradingHoursTemplate: '" + tradingHoursTemplate
					+ "'. Known: " + knownKeys.ToString()
					+ ". Add the entry to TRADING_HOURS_MAP in mcp-bridge.cs.";
				return false;
			}
			try
			{
				tradingHours = TradingHours.Get(nt8TemplateName);
			}
			catch (Exception ex)
			{
				error = "TradingHours.Get('" + nt8TemplateName + "') threw: " + ex.Message;
				return false;
			}
			if (tradingHours == null)
			{
				error = "NT8 has no TradingHours template named '" + nt8TemplateName
					+ "' (mapped from '" + tradingHoursTemplate
					+ "'). Check 'Tools → Trading Hours' in NT8 and update TRADING_HOURS_MAP if NT8 uses a different name on this install.";
				return false;
			}
			return true;
		}

		private void HandleRequestCandles(IDictionary<string, object> obj)
		{
			var id                   = GetString(obj, "id");
			var symbol               = GetString(obj, "symbol");
			var timeframe            = GetString(obj, "timeframe");
			var fromUnix             = GetLong(obj, "from");
			var toUnix               = GetLong(obj, "to");
			var tradingHoursTemplate = GetString(obj, "tradingHoursTemplate");

			if (string.IsNullOrEmpty(id))
			{
				Log("request_candles missing id; dropping");
				return;
			}
			if (string.IsNullOrEmpty(symbol) || !fromUnix.HasValue || !toUnix.HasValue)
			{
				SendErrorResponse(id, "request_candles missing required fields (symbol, from, to)");
				return;
			}
			if (string.IsNullOrEmpty(tradingHoursTemplate))
			{
				// Fail closed: do NOT silently fall back to RTH or any other template.
				SendErrorResponse(id, "request_candles missing required field: tradingHoursTemplate");
				return;
			}

			BarsPeriodType barsPeriodType;
			int            barsPeriodValue;
			string         resolvedTimeframe;
			string         tfError;
			if (!TryResolveBarsPeriod(timeframe, out barsPeriodType, out barsPeriodValue,
				out resolvedTimeframe, out tfError))
			{
				SendErrorResponse(id, tfError);
				return;
			}

			TradingHours nt8TradingHours;
			string       nt8TemplateName;
			string       thError;
			if (!TryResolveTradingHours(tradingHoursTemplate, out nt8TradingHours,
				out nt8TemplateName, out thError))
			{
				SendErrorResponse(id, thError);
				return;
			}

			Log("TradingHours lookup: symbol=" + symbol
				+ " template=" + tradingHoursTemplate
				+ " → NT8 template='" + nt8TemplateName + "'");

			var instrument = ResolveInstrument(symbol);
			if (instrument == null)
			{
				SendErrorResponse(id, "Could not resolve instrument for symbol: " + symbol);
				return;
			}

			DateTime fromDt;
			DateTime toDt;
			try
			{
				fromDt = UnixSecondsToExchangeTime(fromUnix.Value);
				toDt   = UnixSecondsToExchangeTime(toUnix.Value);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "bad timestamp: " + ex.Message);
				return;
			}

			BarsRequest barsRequest;
			try
			{
				barsRequest = new BarsRequest(instrument, fromDt, toDt);
				barsRequest.BarsPeriod = new BarsPeriod
				{
					BarsPeriodType = barsPeriodType,
					Value          = barsPeriodValue,
				};
				barsRequest.TradingHours = nt8TradingHours;
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "BarsRequest construction failed: " + ex.Message);
				return;
			}

			Log("request_candles id=" + id + " symbol=" + symbol + " tf=" + timeframe
				+ " from=" + fromUnix.Value + " to=" + toUnix.Value
				+ " | resolved=" + DescribeInstrument(instrument)
				+ " | ET window=" + fromDt.ToString("yyyy-MM-dd HH:mm:ss")
				+ " → " + toDt.ToString("yyyy-MM-dd HH:mm:ss"));

			try
			{
				barsRequest.Request((bars, errorCode, errorMessage) =>
				{
					try
					{
						if (errorCode != ErrorCode.NoError)
						{
							Log("BarsRequest callback id=" + id + " errorCode=" + errorCode
								+ " errorMessage=" + (errorMessage ?? "<null>")
								+ " | provider " + DescribeProviderState());
							SendErrorResponse(id, "BarsRequest failed: " + errorCode + " — " + errorMessage);
							return;
						}

						var candles = new List<object>();
						long firstTs = 0, lastTs = 0;
						if (bars != null && bars.Bars != null)
						{
							var count = bars.Bars.Count;
							for (int i = 0; i < count; i++)
							{
								var ts = ExchangeTimeToUnixSeconds(bars.Bars.GetTime(i));
								if (i == 0) firstTs = ts;
								lastTs = ts;
								candles.Add(new Dictionary<string, object>
								{
									{ "timestamp", ts },
									{ "open",      bars.Bars.GetOpen(i) },
									{ "high",      bars.Bars.GetHigh(i) },
									{ "low",       bars.Bars.GetLow(i) },
									{ "close",     bars.Bars.GetClose(i) },
									{ "volume",    bars.Bars.GetVolume(i) },
								});
							}
						}

						if (candles.Count == 0)
						{
							Log("BarsRequest callback id=" + id + " returned 0 bars (no error)"
								+ " | bars=" + (bars == null ? "<null>" : (bars.Bars == null ? "<bars.Bars=null>" : "len=0"))
								+ " | provider " + DescribeProviderState()
								+ " | hint: check that a data provider is connected and that historical data exists for this contract/window (try opening the chart manually)");
						}
						else
						{
							Log("BarsRequest callback id=" + id + " returned " + candles.Count + " bars"
								+ " (first=" + firstTs + " last=" + lastTs + ")");
						}

						SendCandlesResponse(id, symbol, resolvedTimeframe, candles);
					}
					catch (Exception ex)
					{
						Log("request_candles callback error: " + ex.Message);
						SendErrorResponse(id, "internal error in BarsRequest callback: " + ex.Message);
					}
					finally
					{
						try { barsRequest.Dispose(); } catch { /* ignore */ }
					}
				});
			}
			catch (Exception ex)
			{
				try { barsRequest.Dispose(); } catch { /* ignore */ }
				SendErrorResponse(id, "BarsRequest.Request threw: " + ex.Message);
			}
		}

		private void SendCandlesResponse(string id, string symbol, string timeframe,
			List<object> candles)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",         1 },
				{ "id",        id },
				{ "type",      "candles_response" },
				{ "symbol",    symbol },
				{ "timeframe", timeframe },
				{ "candles",   candles },
				// Feed that served this fetch; the server rejects sim-feed bars.
				{ "dataSource", ClassifyDataSource() },
			};
			SendFireAndForget(Json.Serialize(payload),
				"candles_response id=" + id + " count=" + candles.Count);
		}

		private void SendErrorResponse(string id, string message)
		{
			SendErrorResponse(id, message, null);
		}

		// `code` is an optional machine-readable classifier (place_order only).
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

		// ---------- live bar subscriptions ----------
		//
		// One live BarsRequest per (symbol, timeframe). Close detection is
		// index-advance: when Update's MaxIndex passes the high-water mark,
		// every index in between just closed (never assume MaxIndex-1 is
		// closed). Payloads build under liveLock, send via the ordered queue.

		private async Task LiveSendLoopAsync(CancellationToken ct)
		{
			try
			{
				foreach (var json in liveSendQueue.GetConsumingEnumerable(ct))
				{
					var ws = socket;
					if (ws == null || ws.State != WebSocketState.Open)
					{
						// Dropped by design: the TS side detects the gap and heals.
						continue;
					}
					try
					{
						await SendJsonAsync(ws, json, CancellationToken.None);
					}
					catch (Exception ex)
					{
						Log("live send failed: " + ex.Message);
					}
				}
			}
			catch (OperationCanceledException) { /* shutting down */ }
			catch (Exception ex) { Log("live send loop error: " + ex.Message); }
			Log("live send loop exiting");
		}

		private void QueueLiveSend(string json, string logTag)
		{
			var queue = liveSendQueue;
			if (queue == null || queue.IsAddingCompleted)
			{
				Log("cannot queue (" + logTag + "): send queue unavailable");
				return;
			}
			if (!queue.TryAdd(json))
				Log("live send queue full — dropped " + logTag + " (TS heal will recover)");
		}

		private void QueueSubscribeAck(string id, string symbol, string timeframe,
			string contract, int seedCount, long seedLastTs, bool alreadyActive)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",             1 },
				{ "id",            id },
				{ "type",          "subscribe_ack" },
				{ "symbol",        symbol },
				{ "timeframe",     timeframe },
				{ "contract",      contract },
				{ "seedCount",     seedCount },
				{ "seedLastTs",    seedLastTs },
				{ "alreadyActive", alreadyActive },
			};
			QueueLiveSend(Json.Serialize(payload),
				"subscribe_ack " + symbol + "/" + timeframe + " id=" + id);
		}

		private void QueueUnsubscribeAck(string id, string symbol, string timeframe, bool removed)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",         1 },
				{ "id",        id },
				{ "type",      "unsubscribe_ack" },
				{ "symbol",    symbol },
				{ "timeframe", timeframe },
				{ "removed",   removed },
			};
			QueueLiveSend(Json.Serialize(payload),
				"unsubscribe_ack " + symbol + "/" + timeframe + " id=" + id);
		}

		private void HandleSubscribeBars(IDictionary<string, object> obj)
		{
			var id                   = GetString(obj, "id");
			var symbol               = GetString(obj, "symbol");
			var timeframe            = GetString(obj, "timeframe");
			var tradingHoursTemplate = GetString(obj, "tradingHoursTemplate");

			if (string.IsNullOrEmpty(id))
			{
				Log("subscribe_bars missing id; dropping");
				return;
			}
			if (string.IsNullOrEmpty(symbol))
			{
				SendErrorResponse(id, "subscribe_bars missing required field: symbol");
				return;
			}
			// No default TF here — an unrequested stream is worse than an error.
			if (string.IsNullOrEmpty(timeframe))
			{
				SendErrorResponse(id, "subscribe_bars missing required field: timeframe");
				return;
			}
			if (string.IsNullOrEmpty(tradingHoursTemplate))
			{
				SendErrorResponse(id, "subscribe_bars missing required field: tradingHoursTemplate");
				return;
			}

			BarsPeriodType periodType;
			int            periodValue;
			string         resolvedTf;
			string         tfError;
			if (!TryResolveBarsPeriod(timeframe, out periodType, out periodValue,
				out resolvedTf, out tfError))
			{
				SendErrorResponse(id, tfError);
				return;
			}

			TradingHours tradingHours;
			string       nt8TemplateName;
			string       thError;
			if (!TryResolveTradingHours(tradingHoursTemplate, out tradingHours,
				out nt8TemplateName, out thError))
			{
				SendErrorResponse(id, thError);
				return;
			}

			var instrument = ResolveInstrument(symbol);
			if (instrument == null)
			{
				SendErrorResponse(id, "Could not resolve instrument for symbol: " + symbol);
				return;
			}

			var key       = symbol + "|" + resolvedTf;
			var tfSeconds = periodType == BarsPeriodType.Second ? periodValue : periodValue * 60;

			LiveSub sub;
			lock (liveLock)
			{
				if (liveSubs.TryGetValue(key, out sub))
				{
					// Idempotent re-subscribe: only claim alreadyActive once truly
					// live. During a pending seed, park the id — the seed callback
					// answers it.
					if (sub.Seeded)
					{
						QueueSubscribeAck(id, symbol, resolvedTf,
							sub.Instrument.FullName, 0, 0, true);
					}
					else
					{
						sub.PendingAckIds.Add(id);
					}
					return;
				}
				sub = new LiveSub
				{
					Key                  = key,
					Symbol               = symbol,
					Timeframe            = resolvedTf,
					TradingHoursTemplate = tradingHoursTemplate,
					TfSeconds            = tfSeconds,
					Instrument           = instrument,
					Seeded               = false,
					LastMaxIndex         = -1,
					Seq                  = 0,
				};
				sub.PendingAckIds.Add(id);
				liveSubs[key] = sub;
			}

			Log("subscribe_bars " + key + " id=" + id
				+ " | resolved=" + DescribeInstrument(instrument)
				+ " | NT8 template='" + nt8TemplateName + "'");

			StartLiveRequest(sub, periodType, periodValue, tradingHours, true);
		}

		// Creates and seeds the BarsRequest for `sub`; answers parked subscribe
		// ids when ackPending. Also the re-seed path after a provider reconnect.
		private void StartLiveRequest(LiveSub sub, BarsPeriodType periodType,
			int periodValue, TradingHours tradingHours, bool ackPending)
		{
			BarsRequest req;
			try
			{
				req = new BarsRequest(sub.Instrument, LiveSeedBarsBack);
				req.BarsPeriod = new BarsPeriod
				{
					BarsPeriodType = periodType,
					Value          = periodValue,
				};
				req.TradingHours = tradingHours;
			}
			catch (Exception ex)
			{
				List<string> failIds = null;
				lock (liveLock)
				{
					liveSubs.Remove(sub.Key);
					failIds = new List<string>(sub.PendingAckIds);
					sub.PendingAckIds.Clear();
				}
				if (ackPending)
					foreach (var fid in failIds)
						SendErrorResponse(fid, "subscribe_bars BarsRequest construction failed: " + ex.Message);
				Log("live BarsRequest construction failed for " + sub.Key + ": " + ex.Message);
				return;
			}

			// Per-sub closure: the handler carries its own sub reference.
			EventHandler<BarsUpdateEventArgs> handler = (s, e) => OnLiveBarsUpdate(sub, e);
			lock (liveLock)
			{
				sub.Request = req;
				sub.Handler = handler;
			}
			req.Update += handler; // attach BEFORE Request; the Seeded gate protects

			try
			{
				req.Request((bars, errorCode, errorMessage) =>
				{
					try
					{
						if (errorCode != ErrorCode.NoError)
						{
							// Seed failed: remove + dispose so a retry isn't wedged;
							// truthful nack.
							List<string> nackIds;
							lock (liveLock)
							{
								liveSubs.Remove(sub.Key);
								nackIds = new List<string>(sub.PendingAckIds);
								sub.PendingAckIds.Clear();
							}
							try { req.Update -= handler; } catch { /* already gone */ }
							try { req.Dispose(); } catch { /* already gone */ }
							Log("subscribe_bars seed failed " + sub.Key + ": " + errorCode
								+ " " + (errorMessage ?? "") + " | provider " + DescribeProviderState());
							if (ackPending)
								foreach (var nid in nackIds)
									SendErrorResponse(nid, "subscribe_bars seed failed: "
										+ errorCode + " — " + (errorMessage ?? ""));
							return;
						}

						int  seedCount  = bars != null && bars.Bars != null ? bars.Bars.Count : 0;
						long seedLastTs = 0;
						if (seedCount > 0)
							seedLastTs = ExchangeTimeToUnixSeconds(bars.Bars.GetTime(seedCount - 1));

						bool stillWanted;
						List<string> ackIds;
						lock (liveLock)
						{
							// An unsubscribe may have raced the seed — don't bring an
							// unregistered sub live or leak its BarsRequest.
							LiveSub cur;
							stillWanted = liveSubs.TryGetValue(sub.Key, out cur)
								&& object.ReferenceEquals(cur, sub);
							if (stillWanted)
							{
								// Last seeded bar counts as forming: emission starts
								// when MaxIndex advances past it — no first-close
								// drop, no history replay.
								sub.LastMaxIndex = seedCount - 1;
								sub.Seeded       = true;
							}
							ackIds = new List<string>(sub.PendingAckIds);
							sub.PendingAckIds.Clear();
						}
						if (!stillWanted)
						{
							try { req.Update -= handler; } catch { /* already gone */ }
							try { req.Dispose(); } catch { /* already gone */ }
							Log("subscribe_bars seed completed after unsubscribe " + sub.Key + " — disposed");
							if (ackPending)
								foreach (var uid in ackIds)
									SendErrorResponse(uid, "subscribe_bars: unsubscribed while the seed was in flight");
							return;
						}
						Log("subscribe_bars seeded " + sub.Key + ": " + seedCount
							+ " bars, lastTs=" + seedLastTs);
						if (ackPending)
							foreach (var aid in ackIds)
								QueueSubscribeAck(aid, sub.Symbol, sub.Timeframe,
									sub.Instrument.FullName, seedCount, seedLastTs, false);
					}
					catch (Exception ex)
					{
						Log("subscribe_bars seed callback error " + sub.Key + ": " + ex.Message);
					}
				});
			}
			catch (Exception ex)
			{
				List<string> failIds;
				lock (liveLock)
				{
					liveSubs.Remove(sub.Key);
					failIds = new List<string>(sub.PendingAckIds);
					sub.PendingAckIds.Clear();
				}
				try { req.Update -= handler; } catch { /* already gone */ }
				try { req.Dispose(); } catch { /* already gone */ }
				if (ackPending)
					foreach (var fid in failIds)
						SendErrorResponse(fid, "subscribe_bars BarsRequest.Request threw: " + ex.Message);
				Log("live BarsRequest.Request threw for " + sub.Key + ": " + ex.Message);
			}
		}

		private void OnLiveBarsUpdate(LiveSub sub, BarsUpdateEventArgs e)
		{
			try
			{
				List<string> payloads = null;
				lock (liveLock)
				{
					// Reject events for unsubscribed/replaced subs and anything
					// arriving before the seed completes.
					LiveSub current;
					if (!liveSubs.TryGetValue(sub.Key, out current)) return;
					if (!object.ReferenceEquals(current, sub)) return;
					if (!sub.Seeded) return;

					int newMax = e.MaxIndex;
					if (newMax <= sub.LastMaxIndex) return;

					var series = e.BarsSeries;
					if (series == null) return;
					var nowUnix = (long) (DateTime.UtcNow - UnixEpoch).TotalSeconds;
					// Classify once per batch, not per bar.
					var barSource = ClassifyDataSource();

					payloads = new List<string>();
					for (int i = Math.Max(sub.LastMaxIndex, 0); i < newMax; i++)
					{
						long ts = ExchangeTimeToUnixSeconds(series.GetTime(i));
						sub.Seq++;
						var msg = new Dictionary<string, object>
						{
							{ "v",         1 },
							{ "type",      "bar_close" },
							{ "symbol",    sub.Symbol },
							{ "timeframe", sub.Timeframe },
							{ "seq",       sub.Seq },
							{ "contract",  sub.Instrument.FullName },
							{ "dataSource", barSource },
							{ "candle",    new Dictionary<string, object>
								{
									{ "timestamp", ts },
									{ "open",      series.GetOpen(i) },
									{ "high",      series.GetHigh(i) },
									{ "low",       series.GetLow(i) },
									{ "close",     series.GetClose(i) },
									{ "volume",    (double) series.GetVolume(i) },
								} },
						};
						// Tag stale catch-up bars so act-on-close consumers skip them.
						if (nowUnix - ts > (long) BackfillThresholdBars * sub.TfSeconds)
							msg["backfill"] = true;
						payloads.Add(Json.Serialize(msg));
					}
					sub.LastMaxIndex = newMax;
				}
				// Built under liveLock, sent after — the queue preserves order.
				if (payloads != null)
					foreach (var p in payloads)
						QueueLiveSend(p, "bar_close " + sub.Key);
			}
			catch (Exception ex)
			{
				Log("live update error " + sub.Key + ": " + ex.Message);
			}
		}

		private void HandleUnsubscribeBars(IDictionary<string, object> obj)
		{
			var id        = GetString(obj, "id");
			var symbol    = GetString(obj, "symbol");
			var timeframe = GetString(obj, "timeframe");

			if (string.IsNullOrEmpty(id))
			{
				Log("unsubscribe_bars missing id; dropping");
				return;
			}
			if (string.IsNullOrEmpty(symbol))
			{
				SendErrorResponse(id, "unsubscribe_bars missing required field: symbol");
				return;
			}
			if (string.IsNullOrEmpty(timeframe))
			{
				SendErrorResponse(id, "unsubscribe_bars missing required field: timeframe");
				return;
			}

			var key = symbol + "|" + timeframe;
			LiveSub sub;
			lock (liveLock)
			{
				if (liveSubs.TryGetValue(key, out sub))
					liveSubs.Remove(key);
			}
			if (sub != null)
			{
				// Outside liveLock: Dispose may block on an in-flight Update
				// that wants the lock (lock-ordering discipline).
				DetachAndDispose(sub);
				Log("unsubscribed " + key);
			}
			else
			{
				Log("unsubscribe_bars: no sub for " + key);
			}
			QueueUnsubscribeAck(id, symbol, timeframe, sub != null);
		}

		// Dispose and recreate every live BarsRequest. Seq keeps counting (the
		// TS side reads continuity from timestamps). Serialized by recreateGate.
		private void RecreateAllLiveSubs()
		{
			lock (recreateGate)
			{
				RecreateAllLiveSubsLocked();
			}
		}

		private void RecreateAllLiveSubsLocked()
		{
			List<LiveSub> snapshot;
			lock (liveLock)
			{
				snapshot = new List<LiveSub>(liveSubs.Values);
				foreach (var s in snapshot) s.Seeded = false;
			}
			Log("recreating " + snapshot.Count + " live subscription(s) after provider reconnect");

			foreach (var sub in snapshot)
			{
				DetachAndDispose(sub);

				BarsPeriodType periodType;
				int            periodValue;
				string         resolvedTf;
				string         tfError;
				if (!TryResolveBarsPeriod(sub.Timeframe, out periodType, out periodValue,
					out resolvedTf, out tfError))
				{
					Log("recreate " + sub.Key + " failed to re-resolve TF: " + tfError);
					lock (liveLock) { liveSubs.Remove(sub.Key); }
					continue;
				}
				// Re-resolve from the sub's OWN template key — never guess.
				TradingHours tradingHours;
				string       nt8TemplateName;
				string       thError;
				if (!TryResolveTradingHours(sub.TradingHoursTemplate, out tradingHours,
					out nt8TemplateName, out thError))
				{
					Log("recreate " + sub.Key + " failed to re-resolve TradingHours: " + thError);
					lock (liveLock) { liveSubs.Remove(sub.Key); }
					continue;
				}

				StartLiveRequest(sub, periodType, periodValue, tradingHours, false);
			}
		}

		private void DisposeAllLiveSubs(string reason)
		{
			List<LiveSub> snapshot;
			lock (liveLock)
			{
				snapshot = new List<LiveSub>(liveSubs.Values);
				liveSubs.Clear();
			}
			if (snapshot.Count == 0) return;
			Log("disposing " + snapshot.Count + " live subscription(s): " + reason);
			foreach (var sub in snapshot) DetachAndDispose(sub);
		}

		// NEVER call under liveLock: BarsRequest.Dispose may synchronously wait
		// on an in-flight Update callback that is itself blocked on liveLock.
		private static void DetachAndDispose(LiveSub sub)
		{
			var req     = sub.Request;
			var handler = sub.Handler;
			if (req == null) return;
			if (handler != null)
			{
				try { req.Update -= handler; } catch { /* already detached */ }
			}
			try { req.Dispose(); } catch { /* already disposed */ }
		}

		// ---------- request_open_charts ----------
		//
		// Enumerates every open chart window/tab. Uses undocumented-but-staff-
		// endorsed API (Globals.AllWindows, Chart, MainTabControl, ChartTab —
		// forum 1055530/100732); may change between NT8 builds, so every hop
		// is null-guarded and failures degrade to skippedWindows, never throw.

		// Per-request dispatcher budget. A window mid-close or with a hung UI
		// thread is counted in skippedWindows rather than stalling the response.
		private const int OpenChartsBudgetMs = 3_000;

		private void HandleRequestOpenCharts(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_open_charts missing id; dropping");
				return;
			}
			// Leave the WS reader thread immediately; it owns no NT state.
			Task.Run(async () =>
			{
				try { await BuildAndSendOpenChartsAsync(id); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "request_open_charts failed: " + ex.Message);
				}
			});
		}

		private async Task BuildAndSendOpenChartsAsync(string id)
		{
			// Snapshot first: the window collection is not documented as
			// thread-safe and other threads open/close windows while we walk.
			var chartWindows = new List<NinjaTrader.Gui.Chart.Chart>();
			try
			{
				foreach (var w in Globals.AllWindows)
				{
					// Type test, not caption match: captions are user-renameable
					// and localized. Only the type test happens on this thread.
					var chart = w as NinjaTrader.Gui.Chart.Chart;
					if (chart != null) chartWindows.Add(chart);
				}
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "window enumeration failed: " + ex.Message);
				return;
			}

			var perWindow = new List<Task<List<Dictionary<string, object>>>>();
			foreach (var chart in chartWindows)
				perWindow.Add(ReadChartWindowAsync(chart));

			// NT8 spreads windows across multiple UI threads; wait on all
			// dispatchers in parallel but never longer than the budget.
			await Task.WhenAny(Task.WhenAll(perWindow), Task.Delay(OpenChartsBudgetMs));

			var charts  = new List<object>();
			var skipped = 0;
			foreach (var t in perWindow)
			{
				if (t.Status == TaskStatus.RanToCompletion && t.Result != null)
					foreach (var tab in t.Result) charts.Add(tab);
				else
					skipped++;
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",              1 },
				{ "id",             id },
				{ "type",           "open_charts_response" },
				{ "charts",         charts },
				{ "skippedWindows", skipped },
			};
			SendFireAndForget(Json.Serialize(payload),
				"open_charts_response id=" + id + " charts=" + charts.Count
				+ (skipped > 0 ? " skippedWindows=" + skipped : ""));
		}

		// Everything below the type test runs on the window's own dispatcher
		// (InvokeAsync, never Invoke — documented deadlock risk). Failures
		// resolve to an empty tab list; they never throw across the boundary.
		private static Task<List<Dictionary<string, object>>> ReadChartWindowAsync(NinjaTrader.Gui.Chart.Chart chart)
		{
			var tcs = new TaskCompletionSource<List<Dictionary<string, object>>>();
			try
			{
				chart.Dispatcher.InvokeAsync(() =>
				{
					var tabs = new List<Dictionary<string, object>>();
					try
					{
						// Title is NT-composed "tab header + caption" — the
						// human label. Caption is only the settable base name.
						string title = null;
						try { title = chart.Title; } catch { /* label only */ }

						var tabControl = chart.MainTabControl;
						if (tabControl != null)
						{
							// ActiveChartControl lags after tab switches
							// (staff-confirmed); SelectedItem is current.
							var selected = tabControl.SelectedItem;
							foreach (var item in tabControl.Items)
							{
								try
								{
									var tabItem  = item as System.Windows.Controls.TabItem;
									var chartTab = tabItem != null
										? tabItem.Content as NinjaTrader.Gui.Chart.ChartTab
										: null;
									if (chartTab == null) continue;
									tabs.Add(DescribeChartTab(title, chartTab,
										object.ReferenceEquals(item, selected)));
								}
								catch (Exception ex) { Log("open_charts tab read failed: " + ex.Message); }
							}
						}
					}
					catch (Exception ex) { Log("open_charts window read failed: " + ex.Message); }
					tcs.TrySetResult(tabs);
				});
			}
			catch (Exception ex)
			{
				// Window mid-close: its dispatcher is already shutting down.
				Log("open_charts dispatch failed: " + ex.Message);
				tcs.TrySetResult(new List<Dictionary<string, object>>());
			}
			return tcs.Task;
		}

		private static Dictionary<string, object> DescribeChartTab(
			string windowTitle,
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			bool isActive)
		{
			string symbol      = "";
			string instrument  = "";
			string timeframe   = "";
			bool   hasRenderer = false;

			var cc = chartTab.ChartControl;

			Bars bars = null;
			try
			{
				// Staff-shown route to the primary series; both hops can be
				// null while the chart is still loading.
				var chartBars = cc != null ? cc.PrimaryBars : null;
				if (chartBars == null && cc != null && cc.BarsArray != null && cc.BarsArray.Count > 0)
					chartBars = cc.BarsArray[0];
				if (chartBars != null) bars = chartBars.Bars;
			}
			catch { /* chart mid-load */ }

			Instrument inst = null;
			try
			{
				inst = bars != null ? bars.Instrument : null;
				// Fallback for tabs whose bars haven't loaded yet
				if (inst == null) inst = chartTab.Instrument;
			}
			catch { /* tab mid-load */ }
			if (inst != null)
			{
				try
				{
					instrument = inst.FullName ?? "";
					symbol     = inst.MasterInstrument != null ? inst.MasterInstrument.Name : "";
				}
				catch { /* instrument mid-teardown */ }
			}

			try
			{
				if (bars != null) timeframe = CompactTimeframe(bars.BarsPeriod);
			}
			catch { /* bars mid-teardown */ }

			try
			{
				if (cc != null && cc.Indicators != null)
					foreach (var ind in cc.Indicators)
						if (ind != null && ind.GetType().Name == "McpBridgeRenderer")
						{
							hasRenderer = true;
							break;
						}
			}
			catch { /* indicator collection mid-mutation */ }

			return new Dictionary<string, object>
			{
				{ "window",      string.IsNullOrEmpty(windowTitle) ? "Chart" : windowTitle },
				{ "symbol",      symbol },
				{ "instrument",  instrument },
				{ "timeframe",   timeframe },
				{ "isActive",    isActive },
				{ "hasRenderer", hasRenderer },
			};
		}

		// Compact form matching the server's timeframe vocabulary
		// (src/core/constants.ts); exotic types (Tick/Range/Volume) keep
		// NT8's own display string.
		private static string CompactTimeframe(BarsPeriod bp)
		{
			if (bp == null) return "";
			switch (bp.BarsPeriodType)
			{
				case BarsPeriodType.Second: return bp.Value + "s";
				case BarsPeriodType.Minute:
					return bp.Value % 60 == 0 ? (bp.Value / 60) + "h" : bp.Value + "m";
				case BarsPeriodType.Day:    return bp.Value + "d";
				case BarsPeriodType.Week:   return bp.Value + "w";
				case BarsPeriodType.Month:  return bp.Value + "mo";
				default:                    return bp.ToString();
			}
		}

		// ---------- navigate_chart ----------
		//
		// Programmatic Go To. Scrolling assigns ChartControl.LastSlotPainted —
		// a public setter that ships in NinjaTrader.Gui.dll but is absent from
		// the help guide (same undocumented-but-shipped tier as the window
		// walk above).

		private const int NavigateChartBudgetMs = 3_000;

		private void HandleNavigateChart(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("navigate_chart missing id; dropping");
				return;
			}
			Task.Run(async () =>
			{
				try { await NavigateChartsAndSendAsync(id, obj); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "navigate_chart failed: " + ex.Message);
				}
			});
		}

		private async Task NavigateChartsAndSendAsync(string id, IDictionary<string, object> obj)
		{
			var symbol = GetString(obj, "symbol");
			if (string.IsNullOrEmpty(symbol))
			{
				SendErrorResponse(id, "navigate_chart requires symbol");
				return;
			}
			var  timeframe    = GetString(obj, "timeframe");
			var  ts           = GetLong(obj, "ts");
			var  barsOnScreen = GetInt(obj, "barsOnScreen");
			bool alignRight   = string.Equals(GetString(obj, "align"), "right", StringComparison.OrdinalIgnoreCase);
			bool activate     = GetBool(obj, "activate") ?? true;

			if (!ts.HasValue && !barsOnScreen.HasValue)
			{
				SendErrorResponse(id, "navigate_chart requires ts and/or barsOnScreen");
				return;
			}

			DateTime? target = null;
			if (ts.HasValue)
			{
				try { target = UnixSecondsToExchangeTime(ts.Value); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "navigate_chart bad ts: " + ex.Message);
					return;
				}
			}

			// Snapshot first (open_charts pattern): only the type test runs here.
			var chartWindows = new List<NinjaTrader.Gui.Chart.Chart>();
			try
			{
				foreach (var w in Globals.AllWindows)
				{
					var chart = w as NinjaTrader.Gui.Chart.Chart;
					if (chart != null) chartWindows.Add(chart);
				}
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "window enumeration failed: " + ex.Message);
				return;
			}

			var perWindow = new List<Task<List<Dictionary<string, object>>>>();
			foreach (var chart in chartWindows)
				perWindow.Add(NavigateChartWindowAsync(chart, symbol, timeframe, target, barsOnScreen, alignRight, activate));

			await Task.WhenAny(Task.WhenAll(perWindow), Task.Delay(NavigateChartBudgetMs));

			var results = new List<object>();
			var skipped = 0;
			foreach (var t in perWindow)
			{
				if (t.Status == TaskStatus.RanToCompletion && t.Result != null)
					foreach (var r in t.Result) results.Add(r);
				else
					skipped++;
			}

			if (results.Count == 0)
			{
				SendErrorResponse(id, skipped > 0
					? "navigate_chart timed out on " + skipped + " chart window(s) — NT8's UI may be busy; retry"
					: "no open chart matches symbol=" + symbol
						+ (string.IsNullOrEmpty(timeframe) ? "" : " timeframe=" + timeframe)
						+ " — call list_open_charts to see what's open");
				return;
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",              1 },
				{ "id",             id },
				{ "type",           "navigate_chart_ack" },
				{ "results",        results },
				{ "matched",        results.Count },
				{ "skippedWindows", skipped },
			};
			SendFireAndForget(Json.Serialize(payload),
				"navigate_chart_ack id=" + id + " matched=" + results.Count
				+ (skipped > 0 ? " skippedWindows=" + skipped : ""));
		}

		// Dispatcher discipline of ReadChartWindowAsync: InvokeAsync only;
		// failures resolve to an empty list, never a throw.
		private static Task<List<Dictionary<string, object>>> NavigateChartWindowAsync(
			NinjaTrader.Gui.Chart.Chart chart,
			string wantSymbol,
			string wantTimeframe,
			DateTime? target,
			int? barsOnScreen,
			bool alignRight,
			bool activate)
		{
			var tcs = new TaskCompletionSource<List<Dictionary<string, object>>>();
			try
			{
				chart.Dispatcher.InvokeAsync(() =>
				{
					var results = new List<Dictionary<string, object>>();
					try
					{
						string title = null;
						try { title = chart.Title; } catch { /* label only */ }

						var tabControl = chart.MainTabControl;
						if (tabControl != null)
						{
							var selected = tabControl.SelectedItem;
							foreach (var item in tabControl.Items)
							{
								try
								{
									var tabItem  = item as System.Windows.Controls.TabItem;
									var chartTab = tabItem != null
										? tabItem.Content as NinjaTrader.Gui.Chart.ChartTab
										: null;
									if (chartTab == null) continue;

									var desc = DescribeChartTab(title, chartTab,
										object.ReferenceEquals(item, selected));
									var tabSymbol    = (desc["symbol"] as string) ?? "";
									var tabTimeframe = (desc["timeframe"] as string) ?? "";
									if (!string.Equals(tabSymbol, wantSymbol, StringComparison.OrdinalIgnoreCase))
										continue;
									if (!string.IsNullOrEmpty(wantTimeframe)
										&& !string.Equals(tabTimeframe, wantTimeframe, StringComparison.OrdinalIgnoreCase))
										continue;

									var result = NavigateChartTab(chartTab, desc, target, barsOnScreen, alignRight);
									if (activate)
									{
										try
										{
											tabControl.SelectedItem = item;
											if (chart.WindowState == System.Windows.WindowState.Minimized)
												chart.WindowState = System.Windows.WindowState.Normal;
											chart.Activate();
											result["activated"] = true;
										}
										catch (Exception ex) { Log("navigate_chart activate failed: " + ex.Message); }
									}
									results.Add(result);
								}
								catch (Exception ex) { Log("navigate_chart tab failed: " + ex.Message); }
							}
						}
					}
					catch (Exception ex) { Log("navigate_chart window failed: " + ex.Message); }
					tcs.TrySetResult(results);
				});
			}
			catch (Exception ex)
			{
				// Window mid-close: its dispatcher is already shutting down.
				Log("navigate_chart dispatch failed: " + ex.Message);
				tcs.TrySetResult(new List<Dictionary<string, object>>());
			}
			return tcs.Task;
		}

		// Dispatcher-thread only; the result mirrors navigateChartResultSchema.
		private static Dictionary<string, object> NavigateChartTab(
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			Dictionary<string, object> desc,
			DateTime? target,
			int? barsOnScreen,
			bool alignRight)
		{
			var result = new Dictionary<string, object>
			{
				{ "window",    desc["window"] },
				{ "symbol",    desc["symbol"] },
				{ "timeframe", desc["timeframe"] },
				{ "ok",        false },
			};

			try
			{
				var cc = chartTab.ChartControl;
				if (cc == null)
				{
					result["error"] = "chart is still loading (no ChartControl)";
					return result;
				}

				Bars bars = null;
				var chartBars = cc.PrimaryBars;
				if (chartBars == null && cc.BarsArray != null && cc.BarsArray.Count > 0)
					chartBars = cc.BarsArray[0];
				if (chartBars != null) bars = chartBars.Bars;
				if (bars == null || bars.Count == 0)
				{
					result["error"] = "chart has no loaded bars";
					return result;
				}

				// ---- zoom ----
				double canvasWidth = cc.CanvasRight - cc.CanvasLeft;
				if (canvasWidth <= 0) canvasWidth = cc.ActualWidth;
				if (barsOnScreen.HasValue && barsOnScreen.Value > 0 && canvasWidth > 0)
				{
					float oldDistance = cc.Properties.BarDistance;
					// Below ~0.4 px/bar nothing renders; above 200 is a handful of bars.
					float newDistance = (float) Math.Max(0.4, Math.Min(200.0, canvasWidth / barsOnScreen.Value));
					cc.Properties.BarDistance = newDistance;
					if (oldDistance > 0 && cc.BarWidth > 0)
						cc.BarWidth = Math.Max(0.5, cc.BarWidth * (newDistance / (double) oldDistance));
				}

				double barDistance  = cc.Properties.BarDistance;
				double slotsVisible = barDistance > 0 && canvasWidth > 0
					? canvasWidth / barDistance
					: cc.SlotsPainted;

				// ---- scroll ----
				bool clamped = false;
				if (target.HasValue)
				{
					DateTime firstLoaded = bars.GetTime(0);
					DateTime lastLoaded  = bars.GetTime(bars.Count - 1);
					DateTime effective   = target.Value;
					if (effective < firstLoaded) { effective = firstLoaded; clamped = true; }
					if (effective > lastLoaded)  { effective = lastLoaded;  clamped = true; }
					if (clamped)
					{
						result["firstLoadedTs"] = ExchangeTimeToUnixSeconds(firstLoaded);
						result["lastLoadedTs"]  = ExchangeTimeToUnixSeconds(lastLoaded);
					}

					if (cc.BarSpacingType == NinjaTrader.Gui.Chart.BarSpacingType.TimeBased)
					{
						// GetSlotIndexByTime throws on TimeBased spacing; fall back
						// to the private ScrollToTime the Go To dialog drives.
						var mi = typeof(NinjaTrader.Gui.Chart.ChartControl).GetMethod(
							"ScrollToTime",
							System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic,
							null,
							new Type[] { typeof(DateTime), typeof(bool) },
							null);
						if (mi == null)
						{
							result["error"] = "TimeBased bar spacing: ScrollToTime not found in this NT8 build";
							return result;
						}
						mi.Invoke(cc, new object[] { effective, alignRight });
						result["method"] = "scrollToTime";
					}
					else
					{
						double targetSlot = cc.GetSlotIndexByTime(effective);
						double lastSlot   = alignRight ? targetSlot : targetSlot + slotsVisible / 2.0;
						// NT's own limits: last bar + right margin on the right,
						// a full canvas of data on the left.
						double marginSlots = barDistance > 0 ? cc.Properties.BarMarginRight / barDistance : 0;
						double maxLastSlot = cc.GetSlotIndexByTime(lastLoaded) + marginSlots;
						double minLastSlot = Math.Min(slotsVisible, maxLastSlot);
						if (lastSlot > maxLastSlot) lastSlot = maxLastSlot;
						if (lastSlot < minLastSlot) lastSlot = minLastSlot;
						cc.LastSlotPainted = (int) Math.Round(lastSlot);
						result["method"] = "slot";
					}
				}

				cc.InvalidateVisual();

				// Achieved range from slot math — the *Painted properties only
				// refresh on the next render pass.
				try
				{
					int lastSlotNow = cc.LastSlotPainted;
					result["visibleFromTs"] = ExchangeTimeToUnixSeconds(
						cc.GetTimeBySlotIndex(Math.Max(0, lastSlotNow - slotsVisible)));
					result["visibleToTs"]   = ExchangeTimeToUnixSeconds(
						cc.GetTimeBySlotIndex(lastSlotNow));
				}
				catch { /* range is informational */ }

				if (clamped) result["clamped"] = true;
				result["ok"] = true;
			}
			catch (Exception ex)
			{
				result["error"] = ex.Message;
			}
			return result;
		}

		// ---------- account / position tracking ----------
		//
		// Read-only observation of Account.All — the no-order-APIs boundary is
		// a design decision. WireAccounts() reconciles per-account handlers
		// against Account.All (re-run on AccountStatusUpdate and provider
		// reconnect); position_sync re-anchors the server with a full snapshot
		// after subscribe / reconnect / roster change.
		//
		// posLock is a LEAF lock: payloads build outside it, then seq + enqueue
		// happen atomically under it so wire order always matches seq order.

		private void OnAccountStatusUpdate(object sender, AccountStatusEventArgs e)
		{
			try
			{
				Task.Run(() =>
				{
					WireAccounts();
					SendPositionSync("account roster change");
				});
			}
			catch (Exception ex)
			{
				Log("OnAccountStatusUpdate error: " + ex.Message);
			}
		}

		// Reconcile per-account handlers with Account.All. Idempotent.
		private void WireAccounts()
		{
			var current = new List<Account>();
			try
			{
				lock (Account.All)
				{
					foreach (var a in Account.All)
						if (a != null) current.Add(a);
				}
			}
			catch (Exception ex)
			{
				Log("WireAccounts: Account.All enumeration failed: " + ex.Message);
				return;
			}

			// Membership reconciles under posLock; NT event accessors (+=/-=)
			// only OUTSIDE it — dispatching NT threads take posLock in the
			// handlers, so nesting the accessors would risk lock-order inversion.
			var toAttach = new List<KeyValuePair<Account, AccountHandlers>>();
			var toDetach = new List<KeyValuePair<Account, AccountHandlers>>();
			lock (posLock)
			{
				foreach (var a in current)
				{
					if (wiredAccounts.ContainsKey(a)) continue;
					var acct = a;
					var h    = new AccountHandlers();
					h.OnPosition  = delegate(object s, PositionEventArgs e)  { OnAccountPositionUpdate(acct, e); };
					h.OnOrder     = delegate(object s, OrderEventArgs e)     { OnAccountOrderUpdate(acct, e); };
					h.OnExecution = delegate(object s, ExecutionEventArgs e) { OnAccountExecutionUpdate(acct, e); };
					wiredAccounts[acct] = h;
					toAttach.Add(new KeyValuePair<Account, AccountHandlers>(acct, h));
				}

				var gone = new List<Account>();
				foreach (var wired in wiredAccounts.Keys)
				{
					var still = false;
					foreach (var a in current)
						if (object.ReferenceEquals(a, wired)) { still = true; break; }
					if (!still) gone.Add(wired);
				}
				foreach (var g in gone)
				{
					toDetach.Add(new KeyValuePair<Account, AccountHandlers>(g, wiredAccounts[g]));
					wiredAccounts.Remove(g);
				}
			}

			foreach (var kvp in toAttach)
			{
				var acct = kvp.Key;
				var h    = kvp.Value;
				try
				{
					acct.PositionUpdate  += h.OnPosition;
					acct.OrderUpdate     += h.OnOrder;
					acct.ExecutionUpdate += h.OnExecution;
				}
				catch (Exception ex)
				{
					Log("WireAccounts attach failed: " + ex.Message);
					lock (posLock) { wiredAccounts.Remove(acct); }
					DetachAccountHandlers(acct, h); // roll back any partial attach
				}
			}
			foreach (var kvp in toDetach)
				DetachAccountHandlers(kvp.Key, kvp.Value);

			if (toAttach.Count > 0 || toDetach.Count > 0)
				Log("WireAccounts: " + current.Count + " account(s), +" + toAttach.Count
					+ " wired, -" + toDetach.Count + " unwired");
		}

		private void UnwireAllAccounts()
		{
			var snapshot = new List<KeyValuePair<Account, AccountHandlers>>();
			lock (posLock)
			{
				foreach (var kvp in wiredAccounts) snapshot.Add(kvp);
				wiredAccounts.Clear();
				positionsStreaming = false;
			}
			foreach (var kvp in snapshot)
				DetachAccountHandlers(kvp.Key, kvp.Value);
		}

		private static void DetachAccountHandlers(Account a, AccountHandlers h)
		{
			if (a == null || h == null) return;
			try { if (h.OnPosition  != null) a.PositionUpdate  -= h.OnPosition; }  catch { /* already gone */ }
			try { if (h.OnOrder     != null) a.OrderUpdate     -= h.OnOrder; }     catch { /* already gone */ }
			try { if (h.OnExecution != null) a.ExecutionUpdate -= h.OnExecution; } catch { /* already gone */ }
		}

		// ---------- position event handlers (NT threads; must never throw) ----------

		private void OnAccountPositionUpdate(Account account, PositionEventArgs e)
		{
			try
			{
				if (!IsStreamingPositions()) return;
				if (e == null || e.Position == null || e.Position.Instrument == null) return;

				// e.MarketPosition/e.Quantity/e.AveragePrice are the account's
				// actual aggregate; e.Position.* can lag or cover only the
				// updating slice. Always serialize the account-level values.
				var payload = new Dictionary<string, object>
				{
					{ "position", BuildPositionCore(
						e.Position.Instrument,
						e.MarketPosition.ToString(),
						e.Quantity,
						e.AveragePrice) },
					{ "operation", e.Operation.ToString() },
				};
				QueuePositionEvent(account, "position", payload);
			}
			catch (Exception ex)
			{
				Log("position update handler error: " + ex.Message);
			}
		}

		private void OnAccountOrderUpdate(Account account, OrderEventArgs e)
		{
			try
			{
				if (!IsStreamingPositions()) return;
				if (e == null || e.Order == null) return;
				var payload = new Dictionary<string, object>
				{
					{ "order", BuildOrderPayload(e.Order) },
				};
				QueuePositionEvent(account, "order", payload);
			}
			catch (Exception ex)
			{
				Log("order update handler error: " + ex.Message);
			}
		}

		private void OnAccountExecutionUpdate(Account account, ExecutionEventArgs e)
		{
			try
			{
				if (!IsStreamingPositions()) return;
				if (e == null || e.Execution == null) return;
				var payload = new Dictionary<string, object>
				{
					{ "execution", BuildExecutionPayload(e.Execution) },
				};
				QueuePositionEvent(account, "execution", payload);
			}
			catch (Exception ex)
			{
				Log("execution update handler error: " + ex.Message);
			}
		}

		private bool IsStreamingPositions()
		{
			lock (posLock) { return positionsStreaming; }
		}

		// seq + enqueue are atomic under posLock (wire order == seq order).
		private void QueuePositionEvent(Account account, string kind,
			Dictionary<string, object> fields)
		{
			var msg = new Dictionary<string, object>
			{
				{ "v",       1 },
				{ "type",    "position_event" },
				{ "account", account != null ? (account.Name ?? "") : "" },
				{ "kind",    kind },
				{ "ts",      (long) (DateTime.UtcNow - UnixEpoch).TotalSeconds },
			};
			foreach (var kvp in fields) msg[kvp.Key] = kvp.Value;

			lock (posLock)
			{
				if (!positionsStreaming) return;
				positionSeq++;
				msg["seq"] = positionSeq;
				QueueLiveSend(Json.Serialize(msg), "position_event " + kind);
			}
		}

		// ---------- payload builders (all reads best-effort) ----------

		private static void PutFinite(Dictionary<string, object> d, string key, double v)
		{
			if (double.IsNaN(v) || double.IsInfinity(v)) return;
			d[key] = v;
		}

		private static string SymbolOf(Instrument inst)
		{
			try
			{
				if (inst != null && inst.MasterInstrument != null)
					return inst.MasterInstrument.Name ?? "";
			}
			catch { /* mid-teardown */ }
			return "";
		}

		private static Dictionary<string, object> BuildPositionCore(
			Instrument inst, string marketPosition, int quantity, double averagePrice)
		{
			var d = new Dictionary<string, object>
			{
				{ "instrument",     inst != null ? (inst.FullName ?? "") : "" },
				{ "symbol",         SymbolOf(inst) },
				{ "marketPosition", marketPosition ?? "" },
				{ "quantity",       quantity },
			};
			PutFinite(d, "averagePrice", averagePrice);
			try
			{
				if (inst != null && inst.MasterInstrument != null)
				{
					PutFinite(d, "pointValue", inst.MasterInstrument.PointValue);
					PutFinite(d, "tickSize",   inst.MasterInstrument.TickSize);
				}
			}
			catch { /* master mid-teardown */ }
			return d;
		}

		// Snapshot flavor: best-effort unrealized PnL and last market price —
		// both need flowing NT market data; omit, never guess.
		private static Dictionary<string, object> BuildPositionSnapshot(Position pos)
		{
			var d = BuildPositionCore(pos.Instrument, pos.MarketPosition.ToString(),
				pos.Quantity, pos.AveragePrice);
			try
			{
				PutFinite(d, "unrealizedPnl",
					pos.GetUnrealizedProfitLoss(PerformanceUnit.Currency));
			}
			catch { /* no market data subscription */ }
			try
			{
				var md = pos.Instrument != null ? pos.Instrument.MarketData : null;
				if (md != null && md.Last != null)
				{
					PutFinite(d, "marketPrice", md.Last.Price);
					if (md.Last.Time > DateTime.MinValue)
						d["marketPriceTs"] = ExchangeTimeToUnixSeconds(md.Last.Time);
				}
			}
			catch { /* no market data subscription */ }
			return d;
		}

		private static Dictionary<string, object> BuildOrderPayload(Order o)
		{
			var d = new Dictionary<string, object>
			{
				{ "orderId",    o.OrderId ?? "" },
				{ "name",       o.Name ?? "" },
				{ "instrument", o.Instrument != null ? (o.Instrument.FullName ?? "") : "" },
				{ "symbol",     SymbolOf(o.Instrument) },
				{ "action",     o.OrderAction.ToString() },
				{ "orderType",  o.OrderType.ToString() },
				{ "state",      o.OrderState.ToString() },
				{ "quantity",   o.Quantity },
				{ "filled",     o.Filled },
			};
			PutFinite(d, "limitPrice",   o.LimitPrice);
			PutFinite(d, "stopPrice",    o.StopPrice);
			PutFinite(d, "avgFillPrice", o.AverageFillPrice);
			try
			{
				if (o.Time > DateTime.MinValue)
					d["time"] = ExchangeTimeToUnixSeconds(o.Time);
			}
			catch { /* unparseable order time */ }
			if (!string.IsNullOrEmpty(o.Oco)) d["oco"] = o.Oco;
			return d;
		}

		private static Dictionary<string, object> BuildExecutionPayload(Execution x)
		{
			var d = new Dictionary<string, object>
			{
				{ "executionId", x.ExecutionId ?? "" },
				{ "orderId",     x.OrderId ?? "" },
				{ "instrument",  x.Instrument != null ? (x.Instrument.FullName ?? "") : "" },
				{ "symbol",      SymbolOf(x.Instrument) },
				{ "side",        x.MarketPosition.ToString() },
				{ "quantity",    x.Quantity },
			};
			PutFinite(d, "price", x.Price);
			try
			{
				if (x.Time > DateTime.MinValue)
					d["time"] = ExchangeTimeToUnixSeconds(x.Time);
			}
			catch { /* unparseable execution time */ }
			if (!string.IsNullOrEmpty(x.Name)) d["orderName"] = x.Name;
			PutFinite(d, "commission", x.Commission);
			return d;
		}

		private static bool TryGetAccountItemValue(Account a, AccountItem item, out double value)
		{
			value = 0;
			try
			{
				value = a.Get(item, a.Denomination);
				return !double.IsNaN(value) && !double.IsInfinity(value);
			}
			catch { return false; }
		}

		// Full per-account snapshot: identity, account values, non-flat
		// positions, and non-terminal (working) orders.
		private static Dictionary<string, object> BuildAccountSnapshot(Account a)
		{
			var d = new Dictionary<string, object> { { "name", a.Name ?? "" } };

			try
			{
				var conn = a.Connection;
				d["connection"] = conn != null && conn.Options != null
					? (conn.Options.Name ?? "") : "";
				d["connectionStatus"] = conn != null ? conn.Status.ToString() : "NoConnection";
			}
			catch { d["connection"] = ""; d["connectionStatus"] = "Unknown"; }

			try { d["denomination"] = a.Denomination.ToString(); }
			catch { /* omit */ }

			double v;
			if (TryGetAccountItemValue(a, AccountItem.RealizedProfitLoss, out v)) d["realizedPnl"]    = v;
			if (TryGetAccountItemValue(a, AccountItem.CashValue,          out v)) d["cashValue"]      = v;
			if (TryGetAccountItemValue(a, AccountItem.NetLiquidation,     out v)) d["netLiquidation"] = v;

			var positions = new List<object>();
			try
			{
				var posSnapshot = new List<Position>();
				lock (a.Positions)
				{
					foreach (var p in a.Positions)
						if (p != null) posSnapshot.Add(p);
				}
				foreach (var p in posSnapshot)
				{
					try
					{
						if (p.MarketPosition == MarketPosition.Flat || p.Quantity == 0) continue;
						positions.Add(BuildPositionSnapshot(p));
					}
					catch (Exception ex) { Log("position snapshot failed: " + ex.Message); }
				}
			}
			catch (Exception ex) { Log("positions enumeration failed for " + d["name"] + ": " + ex.Message); }
			d["positions"] = positions;

			var orders = new List<object>();
			try
			{
				var ordSnapshot = new List<Order>();
				lock (a.Orders)
				{
					foreach (var o in a.Orders)
						if (o != null) ordSnapshot.Add(o);
				}
				foreach (var o in ordSnapshot)
				{
					try
					{
						if (Order.IsTerminalState(o.OrderState)) continue;
						orders.Add(BuildOrderPayload(o));
					}
					catch (Exception ex) { Log("order snapshot failed: " + ex.Message); }
				}
			}
			catch (Exception ex) { Log("orders enumeration failed for " + d["name"] + ": " + ex.Message); }
			d["orders"] = orders;

			return d;
		}

		private static List<object> BuildAccountsSnapshotList()
		{
			var accounts = new List<Account>();
			lock (Account.All)
			{
				foreach (var a in Account.All)
					if (a != null) accounts.Add(a);
			}
			var list = new List<object>();
			foreach (var a in accounts)
			{
				try { list.Add(BuildAccountSnapshot(a)); }
				catch (Exception ex) { Log("account snapshot failed: " + ex.Message); }
			}
			return list;
		}

		// ---------- position request handlers (Task.Run context) ----------

		private void HandleRequestPositions(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_positions missing id; dropping");
				return;
			}
			try
			{
				var accounts = BuildAccountsSnapshotList();
				var payload = new Dictionary<string, object>
				{
					{ "v",        1 },
					{ "id",       id },
					{ "type",     "positions_response" },
					{ "accounts", accounts },
				};
				SendFireAndForget(Json.Serialize(payload),
					"positions_response id=" + id + " accounts=" + accounts.Count);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "request_positions failed: " + ex.Message);
			}
		}

		private void HandleSubscribePositions(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("subscribe_positions missing id; dropping");
				return;
			}
			try
			{
				WireAccounts();

				bool already;
				var wired = new List<Account>();
				lock (posLock)
				{
					already = positionsStreaming;
					positionsStreaming = true;
					foreach (var a in wiredAccounts.Keys) wired.Add(a);
				}

				// NT property reads happen outside posLock (leaf-lock discipline).
				var names = new List<string>();
				foreach (var a in wired)
				{
					try { names.Add(a.Name ?? ""); }
					catch { /* account mid-teardown */ }
				}

				var payload = new Dictionary<string, object>
				{
					{ "v",             1 },
					{ "id",            id },
					{ "type",          "subscribe_positions_ack" },
					{ "accounts",      names },
					{ "alreadyActive", already },
				};
				SendFireAndForget(Json.Serialize(payload),
					"subscribe_positions_ack id=" + id + " accounts=" + names.Count);
				Log("position streaming ON (" + names.Count + " account(s) wired)");

				// Authoritative baseline so the server's state starts anchored.
				SendPositionSync("subscribed");
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "subscribe_positions failed: " + ex.Message);
			}
		}

		private void HandleUnsubscribePositions(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("unsubscribe_positions missing id; dropping");
				return;
			}
			try
			{
				bool removed;
				lock (posLock)
				{
					removed = positionsStreaming;
					positionsStreaming = false;
				}
				// Handlers stay wired but gated — cheaper and safer than
				// re-wiring on every toggle.
				var payload = new Dictionary<string, object>
				{
					{ "v",       1 },
					{ "id",      id },
					{ "type",    "unsubscribe_positions_ack" },
					{ "removed", removed },
				};
				SendFireAndForget(Json.Serialize(payload), "unsubscribe_positions_ack id=" + id);
				Log("position streaming OFF");
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "unsubscribe_positions failed: " + ex.Message);
			}
		}

		// Full snapshot via the ORDERED live queue (seq-stamped) so it can't
		// overtake earlier events. No-op while streaming is off.
		private void SendPositionSync(string reason)
		{
			try
			{
				if (!IsStreamingPositions()) return;
				var accounts = BuildAccountsSnapshotList();
				var msg = new Dictionary<string, object>
				{
					{ "v",        1 },
					{ "type",     "position_sync" },
					{ "reason",   reason ?? "" },
					{ "ts",       (long) (DateTime.UtcNow - UnixEpoch).TotalSeconds },
					{ "accounts", accounts },
				};
				lock (posLock)
				{
					if (!positionsStreaming) return;
					positionSeq++;
					msg["seq"] = positionSeq;
					QueueLiveSend(Json.Serialize(msg), "position_sync (" + reason + ")");
				}
			}
			catch (Exception ex)
			{
				Log("SendPositionSync failed: " + ex.Message);
			}
		}

		// ---------- order placement (write path) ----------
		//
		// Crosses the historically read-only boundary. This is the KEYSTONE
		// safety gate: it is independent of the TS-side gate and, because there
		// is no C# compiler on the trading machine, it cannot be recompiled away
		// by an agent. It fails closed — a missing/garbled trading.config.json,
		// a disabled flag, an off-allow-list account, or an over-cap quantity all
		// reject before Submit(). Idempotency: a repeated clientOrderId replays
		// the prior ack instead of firing a second order.

		private const string TradingConfigFileName = "trading.config.json";

		private readonly object orderLock = new object();
		private readonly Dictionary<string, SubmittedOrder> submittedOrders =
			new Dictionary<string, SubmittedOrder>(StringComparer.Ordinal);

		private class SubmittedOrder
		{
			public string Contract;
			public string OrderId;
			public string State;
			// false = an in-flight reservation (a submit holds this clientOrderId
			// but Submit() has not yet succeeded); true = a real, submitted order
			// whose ack can be replayed. See HandlePlaceOrder's dedup section.
			public bool   Completed;
		}

		private class TradingGateConfig
		{
			public bool         enabled;
			public List<string> allowAccounts;
			public int          maxQty;
		}

		// Re-read every submit so the gate can be toggled without an NT8 restart.
		// Returns null on any problem — the caller treats null as "disabled."
		private TradingGateConfig LoadTradingGate()
		{
			var path = Path.Combine(Globals.UserDataDir, TradingConfigFileName);
			if (!File.Exists(path))
			{
				Log("trading gate: no " + TradingConfigFileName + " at " + path + " — write path disabled (create it with {\"enabled\":true,\"allowAccounts\":[\"Sim101\"],\"maxQty\":2})");
				return null;
			}
			try
			{
				var json = File.ReadAllText(path);
				return Json.Deserialize<TradingGateConfig>(json);
			}
			catch (Exception ex)
			{
				Log("trading gate: failed to parse " + TradingConfigFileName + " — write path disabled: " + ex.Message);
				return null;
			}
		}

		private Account FindAccount(string name)
		{
			try
			{
				lock (Account.All)
				{
					foreach (var a in Account.All)
					{
						if (a == null) continue;
						try { if (string.Equals(a.Name, name, StringComparison.Ordinal)) return a; }
						catch { /* account mid-teardown */ }
					}
				}
			}
			catch (Exception ex) { Log("FindAccount failed: " + ex.Message); }
			return null;
		}

		private static bool TryParseAction(string s, out OrderAction a)
		{
			a = OrderAction.Buy;
			if (string.Equals(s, "Buy",  StringComparison.OrdinalIgnoreCase)) { a = OrderAction.Buy;  return true; }
			if (string.Equals(s, "Sell", StringComparison.OrdinalIgnoreCase)) { a = OrderAction.Sell; return true; }
			return false;
		}

		private static bool TryParseOrderType(string s, out OrderType t)
		{
			t = OrderType.Market;
			if (string.Equals(s, "Market",    StringComparison.OrdinalIgnoreCase)) { t = OrderType.Market;     return true; }
			if (string.Equals(s, "Limit",     StringComparison.OrdinalIgnoreCase)) { t = OrderType.Limit;      return true; }
			if (string.Equals(s, "Stop",      StringComparison.OrdinalIgnoreCase)) { t = OrderType.StopMarket; return true; }
			if (string.Equals(s, "StopLimit", StringComparison.OrdinalIgnoreCase)) { t = OrderType.StopLimit;  return true; }
			return false;
		}

		private static bool TryParseTif(string s, out TimeInForce t)
		{
			t = TimeInForce.Day;
			if (string.Equals(s, "Day", StringComparison.OrdinalIgnoreCase)) { t = TimeInForce.Day; return true; }
			if (string.Equals(s, "Gtc", StringComparison.OrdinalIgnoreCase)) { t = TimeInForce.Gtc; return true; }
			return false;
		}

		private void HandlePlaceOrder(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("place_order missing id; dropping"); return; }

			// reserved  : an in-flight placeholder was inserted for clientOrderId.
			// committed : Submit() succeeded — never auto-remove the reservation
			//             past this point, or a retry would double-fire.
			// ambiguous : Submit() itself threw, so it's not provably unsent either
			//             — keep the reservation so a same-id retry is refused
			//             rather than silently resubmitted.
			// The finally below removes the reservation only when none of the above
			// hold, so a genuinely pre-Submit blocked/failed id stays retryable.
			string clientOrderId = null;
			bool   reserved  = false;
			bool   committed = false;
			bool   ambiguous = false;

			try
			{
				clientOrderId     = GetString(obj, "clientOrderId");
				var accountName   = GetString(obj, "account");
				var symbol        = GetString(obj, "symbol");
				var actionStr     = GetString(obj, "action");
				var typeStr       = GetString(obj, "orderType");
				var tifStr        = GetString(obj, "tif");
				var qtyN          = GetInt(obj, "quantity");

				// Pre-reservation validation — certainly not submitted.
				if (string.IsNullOrEmpty(clientOrderId)) { SendErrorResponse(id, "place_order missing clientOrderId", "invalid-params"); return; }
				if (string.IsNullOrEmpty(accountName))   { SendErrorResponse(id, "place_order missing account",       "invalid-params"); return; }
				if (string.IsNullOrEmpty(symbol))        { SendErrorResponse(id, "place_order missing symbol",        "invalid-params"); return; }
				if (!qtyN.HasValue || qtyN.Value <= 0)   { SendErrorResponse(id, "place_order quantity must be a positive integer", "invalid-params"); return; }
				var quantity = qtyN.Value;

				// Check + reserve is atomic under one lock, so two concurrent
				// messages with the same clientOrderId can't both Submit(): a
				// completed entry replays the original ack, an in-flight entry is
				// refused, and only an absent entry gets reserved and proceeds.
				// submittedOrders is in-memory/per-session — a restart forgets it,
				// which is fine since the TS side always generates fresh UUIDs.
				lock (orderLock)
				{
					SubmittedOrder prior;
					if (submittedOrders.TryGetValue(clientOrderId, out prior))
					{
						if (prior.Completed)
						{
							Log("place_order dedup: clientOrderId=" + clientOrderId + " already submitted; replaying ack");
							SendOrderAck(id, clientOrderId, prior.Contract, prior.OrderId, prior.State, true);
							return;
						}
						Log("place_order dedup: clientOrderId=" + clientOrderId + " is in flight; refusing concurrent resubmit");
						SendErrorResponse(id,
							"order with clientOrderId '" + clientOrderId + "' is currently in flight — do not resubmit; check again shortly",
							"in-flight");
						return;
					}
					submittedOrders[clientOrderId] = new SubmittedOrder { Completed = false };
				}
				reserved = true;

				// Gate — keystone, fail-closed, re-read fresh every submit.
				var gate = LoadTradingGate();
				if (gate == null || !gate.enabled)
				{
					SendErrorResponse(id, "AddOn trading gate disabled (trading.config.json missing or enabled=false)", "gate-disabled");
					Log("place_order BLOCKED (gate disabled) account=" + accountName + " " + actionStr + " " + quantity + " " + symbol);
					return;
				}
				if (gate.allowAccounts == null || !gate.allowAccounts.Contains(accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("place_order BLOCKED (account not allowed) account=" + accountName);
					return;
				}
				if (quantity > gate.maxQty)
				{
					SendErrorResponse(id, "quantity " + quantity + " exceeds AddOn maxQty " + gate.maxQty, "qty-exceeds-max");
					Log("place_order BLOCKED (qty>max) qty=" + quantity + " max=" + gate.maxQty + " account=" + accountName);
					return;
				}

				OrderAction action;
				OrderType   orderType;
				TimeInForce tif;
				if (!TryParseAction(actionStr, out action))     { SendErrorResponse(id, "invalid action: "    + actionStr, "invalid-params"); return; }
				if (!TryParseOrderType(typeStr, out orderType)) { SendErrorResponse(id, "invalid orderType: " + typeStr,   "invalid-params"); return; }
				if (!TryParseTif(tifStr, out tif))              { SendErrorResponse(id, "invalid tif: "       + tifStr,    "invalid-params"); return; }

				var needLimit = orderType == OrderType.Limit || orderType == OrderType.StopLimit;
				var needStop  = orderType == OrderType.StopMarket || orderType == OrderType.StopLimit;
				var limitPrice = GetDouble(obj, "limitPrice");
				var stopPrice  = GetDouble(obj, "stopPrice");
				if (needLimit && !(limitPrice > 0)) { SendErrorResponse(id, typeStr + " requires a positive limitPrice", "invalid-params"); return; }
				if (needStop  && !(stopPrice  > 0)) { SendErrorResponse(id, typeStr + " requires a positive stopPrice",  "invalid-params"); return; }

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var instrument = ResolveInstrument(symbol);
				if (instrument == null) { SendErrorResponse(id, "could not resolve instrument for symbol: " + symbol, "instrument-not-found"); return; }

				Order order;
				try
				{
					order = account.CreateOrder(
						instrument, action, orderType, OrderEntry.Automated, tif,
						quantity, limitPrice, stopPrice,
						"",              // oco — no bracket in phase 1
						clientOrderId,   // name — correlation + dedupe key (<= 50 chars)
						Globals.MaxDate, // gtd — non-GTD
						null);           // customOrder
				}
				catch (Exception ex) { SendErrorResponse(id, "CreateOrder failed: " + ex.Message, "create-order-failed"); return; }

				try { account.Submit(new[] { order }); }
				catch (Exception ex)
				{
					ambiguous = true;
					SendErrorResponse(id, "Submit failed: " + ex.Message, "submit-failed");
					return;
				}

				// Never auto-remove the reservation past this line. Overwriting it
				// below with Completed=true also enables idempotent ack replay for
				// a timed-out-then-retried submit.
				committed = true;

				// Guarded: an unguarded throw here would skip the Completed=true
				// overwrite below and strand this id as in-flight forever. Fall
				// back rather than throw.
				var contract = symbol;
				try { contract = instrument.FullName ?? symbol; } catch { /* transient — keep symbol */ }
				string orderId = null;
				var state = "Submitted";
				try { orderId = order.OrderId; }          catch { /* not assigned yet */ }
				try { state = order.OrderState.ToString(); } catch { /* transient */ }

				lock (orderLock)
				{
					submittedOrders[clientOrderId] =
						new SubmittedOrder { Contract = contract, OrderId = orderId, State = state, Completed = true };
				}

				Log("place_order SUBMITTED account=" + accountName + " " + actionStr + " " + quantity
					+ " " + contract + " type=" + typeStr + " coid=" + clientOrderId + " state=" + state);
				SendOrderAck(id, clientOrderId, contract, orderId, state, false);
			}
			catch (Exception ex)
			{
				// Unexpected, codeless failure — the TS side treats it as ambiguous.
				SendErrorResponse(id, "place_order failed: " + ex.Message);
			}
			finally
			{
				if (reserved && !committed && !ambiguous)
				{
					lock (orderLock) { submittedOrders.Remove(clientOrderId); }
				}
			}
		}

		private void SendOrderAck(string id, string clientOrderId, string contract,
			string orderId, string state, bool deduped)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",             1 },
				{ "id",            id },
				{ "type",          "order_ack" },
				{ "clientOrderId", clientOrderId ?? "" },
				{ "contract",      contract ?? "" },
				{ "state",         state ?? "" },
				{ "deduped",       deduped },
			};
			if (!string.IsNullOrEmpty(orderId)) payload["orderId"] = orderId;
			SendFireAndForget(Json.Serialize(payload), "order_ack coid=" + clientOrderId + " id=" + id);
		}

		// ---------- logging ----------

		private static void Log(string msg)
		{
			Output.Process("[McpBridge] " + msg, PrintTo.OutputTab1);
		}
	}
}
