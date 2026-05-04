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

	public class McpBridge : NinjaTrader.NinjaScript.AddOnBase
	{
		private const int    HeartbeatIntervalMs = 10_000;
		private const int    ReconnectMinMs      = 1_000;
		private const int    ReconnectMaxMs      = 30_000;
		private const string ConfigFileName      = "bridge.config.json";

		public  static McpBridge Instance { get; private set; }

		public  static event Action<DrawZoneCommand>  DrawZoneReceived;
		public  static event Action<ClearZonesCommand> ClearZonesReceived;

		private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

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
					var handler = DrawZoneReceived;
					if (handler != null) handler(cmd);
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
					var handler = ClearZonesReceived;
					if (handler != null) handler(cmd);
					break;
				}

				case "request_candles":
					HandleRequestCandles(obj);
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

		private void HandleRequestCandles(IDictionary<string, object> obj)
		{
			var id        = GetString(obj, "id");
			var symbol    = GetString(obj, "symbol");
			var timeframe = GetString(obj, "timeframe");
			var fromUnix  = GetLong(obj, "from");
			var toUnix    = GetLong(obj, "to");

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
					BarsPeriodType = BarsPeriodType.Minute,
					Value          = 15,
				};
				barsRequest.TradingHours = TradingHours.Get("CME US Index Futures RTH");
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

						SendCandlesResponse(id, symbol, "15m", candles);
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
