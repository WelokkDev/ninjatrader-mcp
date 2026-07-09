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
			{ "nymex_energy_eth",         "CME US Energy ETH" },
			{ "comex_metals_eth",         "COMEX Metals ETH" },
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
			};
			await SendJsonAsync(ws, Json.Serialize(hello), ct);
			Log("sent hello (" + instruments.Count + " instruments)");
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

				case "request_session_calendar":
					HandleRequestSessionCalendar(obj);
					break;

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
						{ "isEarlyClose", partial != null && partial.IsEarlyClose },
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
			if (string.IsNullOrEmpty(timeframe))
			{
				barsPeriodType    = BarsPeriodType.Minute;
				barsPeriodValue   = 15;
				resolvedTimeframe = "15m";
			}
			else if (!ALLOWED_RAW_TIMEFRAMES.Contains(timeframe))
			{
				SendErrorResponse(id, "Unsupported timeframe for request_candles: '"
					+ timeframe + "'. Supported raw TFs: " + string.Join(", ", ALLOWED_RAW_TIMEFRAMES) + ".");
				return;
			}
			else
			{
				var unit = timeframe[timeframe.Length - 1];
				int n;
				if (!int.TryParse(timeframe.Substring(0, timeframe.Length - 1), out n) || n <= 0)
				{
					SendErrorResponse(id, "Malformed timeframe for request_candles: '" + timeframe + "'");
					return;
				}
				barsPeriodType    = unit == 's' ? BarsPeriodType.Second : BarsPeriodType.Minute;
				barsPeriodValue   = n;
				resolvedTimeframe = timeframe;
			}

			string nt8TemplateName;
			if (!TRADING_HOURS_MAP.TryGetValue(tradingHoursTemplate, out nt8TemplateName))
			{
				var knownKeys = new StringBuilder();
				foreach (var k in TRADING_HOURS_MAP.Keys)
				{
					if (knownKeys.Length > 0) knownKeys.Append(", ");
					knownKeys.Append(k);
				}
				SendErrorResponse(id, "Unknown tradingHoursTemplate: '" + tradingHoursTemplate
					+ "'. Known: " + knownKeys.ToString()
					+ ". Add the entry to TRADING_HOURS_MAP in mcp-bridge.cs.");
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
				SendErrorResponse(id, "NT8 has no TradingHours template named '" + nt8TemplateName
					+ "' (mapped from '" + tradingHoursTemplate
					+ "'). Check 'Tools → Trading Hours' in NT8 and update TRADING_HOURS_MAP if NT8 uses a different name on this install.");
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
			};
			SendFireAndForget(Json.Serialize(payload),
				"candles_response id=" + id + " count=" + candles.Count);
		}

		private void SendErrorResponse(string id, string message)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",       1 },
				{ "id",      id },
				{ "type",    "error" },
				{ "message", message },
			};
			SendFireAndForget(Json.Serialize(payload),
				"error id=" + id + " msg=" + message);
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

		// ---------- logging ----------

		private static void Log(string msg)
		{
			Output.Process("[McpBridge] " + msg, PrintTo.OutputTab1);
		}
	}
}
