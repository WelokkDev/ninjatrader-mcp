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

namespace NinjaTrader.NinjaScript.AddOns
{
	public partial class McpBridge
	{
		// Raw timeframes this bridge will serve via request_candles. Keep in
		// sync with RAW_TIMEFRAMES in the server's src/core/constants.ts.
		// "1d" is historical-fetch only — subscribe_bars rejects it (see
		// HandleSubscribeBars); the server's LIVE_TIMEFRAMES matches.
		private static readonly HashSet<string> ALLOWED_RAW_TIMEFRAMES =
			new HashSet<string>(StringComparer.Ordinal) { "1s", "5s", "15s", "1m", "5m", "15m", "1d" };

		// Fallback for servers that send no nt8TradingHours; a new template needs no entry here.
		private static readonly Dictionary<string, string> TRADING_HOURS_MAP =
			new Dictionary<string, string>(StringComparer.Ordinal)
		{
			{ "cme_us_index_futures_eth", "CME US Index Futures ETH" },
			// NT8 ships one combined template for NYMEX energy + COMEX metals.
			{ "nymex_energy_eth",         "Nymex Metals - Energy ETH" },
			{ "comex_metals_eth",         "Nymex Metals - Energy ETH" },
		};

		// Concurrent, not lock-guarded: a lock here would add an ordering under liveLock.
		private readonly ConcurrentDictionary<string, Resolution> instrumentCache
			= new ConcurrentDictionary<string, Resolution>();
		private string lastRebindSessionDate;

		// request_candles

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

		// NT8's session, and its roll, begin at 18:00 ET: from then on the date
		// that matters is tomorrow's.
		private static DateTime SessionDateEastern()
		{
			return TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, EasternTz).AddHours(6).Date;
		}

		// Rejects NT8's non-contract records: the template (MinValue/1900) and the
		// MaxDate "never expires" placeholder, which has no delivery month — the
		// feed returns zero bars for it, with no error.
		private static bool IsRealContract(Instrument inst)
		{
			if (inst == null) return false;
			try
			{
				if (inst.Expiry >= Core.Globals.MaxDate) return false;
				return inst.Expiry.Year >= 1970;
			}
			catch { return false; }
		}

		// Stop trading on the third Friday of the delivery month. Mirrors REGISTRY.
		private static readonly HashSet<string> QuarterlyIndexRoots =
			new HashSet<string>(StringComparer.OrdinalIgnoreCase)
			{ "ES", "NQ", "YM", "RTY", "MES", "MNQ", "MYM", "M2K" };

		// NT8's Expiry is the FIRST of the delivery month, not the last trading day
		// (NQ DEC26 reads 2026-12-01); there is no other date member.
		private static DateTime LastTradeDay(Instrument inst)
		{
			var e    = inst.Expiry;
			var root = inst.MasterInstrument != null ? inst.MasterInstrument.Name : "";
			if (QuarterlyIndexRoots.Contains(root))
			{
				var first  = new DateTime(e.Year, e.Month, 1);
				var toFri  = ((int) DayOfWeek.Friday - (int) first.DayOfWeek + 7) % 7;
				return first.AddDays(toFri + 14);
			}
			return new DateTime(e.Year, e.Month, DateTime.DaysInMonth(e.Year, e.Month));
		}

		private static bool IsUnexpired(Instrument inst, DateTime today)
		{
			if (!IsRealContract(inst)) return false;
			try { return LastTradeDay(inst) >= today; }
			catch { return false; }
		}

		// Installs render contract names as either "NQ 09-26" or "NQ SEP26";
		// assuming one silently disables every name-based path on the other.
		private static bool IsFullContractName(string symbol)
		{
			return symbol != null
				&& System.Text.RegularExpressions.Regex.IsMatch(
					symbol, @"\s(\d{2}-\d{2}|[A-Za-z]{3}\d{2})$");
		}

		private static string[] ContractNameCandidates(string master, DateTime month)
		{
			var inv = System.Globalization.CultureInfo.InvariantCulture;
			var mmm = month.ToString("MMM", inv).ToUpperInvariant();
			return new[]
			{
				string.Format(inv, "{0} {1:D2}-{2:D2}", master, month.Month, month.Year % 100),
				string.Format(inv, "{0} {1}{2:D2}", master, mmm, month.Year % 100),
			};
		}

		// A bare symbol resolves badly two ways: GetInstrument returns null on some
		// installs, and the root is often an equity ticker too ("ES" is Eversource,
		// "CL" is Colgate) whose master has no rollover table. Hence futures-only,
		// with a catalog scan behind it.
		private static MasterInstrument MasterFor(string symbol)
		{
			try
			{
				var direct = Instrument.GetInstrument(symbol);
				if (direct != null && direct.MasterInstrument != null
					&& direct.MasterInstrument.InstrumentType == InstrumentType.Future)
					return direct.MasterInstrument;
			}
			catch (Exception ex)
			{
				Log("ResolveInstrument: GetInstrument('" + symbol + "') threw: " + ex.Message);
			}
			try
			{
				foreach (var i in Instrument.All)
				{
					if (i == null || i.MasterInstrument == null) continue;
					if (i.MasterInstrument.InstrumentType != InstrumentType.Future) continue;
					if (string.Equals(i.MasterInstrument.Name, symbol, StringComparison.OrdinalIgnoreCase))
						return i.MasterInstrument;
				}
			}
			catch (Exception ex)
			{
				Log("ResolveInstrument: master scan threw for '" + symbol + "': " + ex.Message);
			}
			return null;
		}

		// What resolved, and on whose authority. Reads take any real contract;
		// risk-adding orders need attested + tradable; risk-reducing ops reach
		// every exposed contract.
		private sealed class Resolution
		{
			public Instrument Instrument;
			public string     Source;    // "explicit" | "rollover-table" | "expiry-scan" | "name-probe"
			public bool       Attested;  // explicit name, or NT8's own rollover table
			public bool       Tradable;  // real and not past its last trading day
			public static readonly Resolution None = new Resolution { Source = "none" };
		}

		// The authority on which contract is front: the active row is the latest
		// whose Date has passed. Windows are [Date, next Date), matching the server.
		private Instrument FrontMonthFromRollovers(string symbol, DateTime today)
		{
			var inv    = System.Globalization.CultureInfo.InvariantCulture;
			var master = MasterFor(symbol);
			if (master == null)
			{
				Log("ResolveInstrument: no MasterInstrument for '" + symbol
					+ "'; the rollover table cannot be read");
				return null;
			}

			// Paired only on a complete row, so a newest row with a default
			// ContractMonth cannot discard every earlier valid window.
			var  bestRoll  = DateTime.MinValue;
			var  bestMonth = DateTime.MinValue;
			bool found     = false;
			try
			{
				var coll = master.RolloverCollection;
				if (coll == null)
				{
					Log("ResolveInstrument: '" + symbol + "' has no RolloverCollection; falling through");
					return null;
				}
				foreach (var r in coll)
				{
					if (r == null) continue;
					if (r.ContractMonth == DateTime.MinValue || r.Date == DateTime.MinValue) continue;
					var rd = r.Date.Date; // the server compares yyyy-MM-dd
					if (rd > today) continue;              // window has not opened yet
					if (found && rd < bestRoll) continue;  // keep the latest opened window
					bestRoll  = rd;
					bestMonth = r.ContractMonth;
					found     = true;
				}
			}
			catch (Exception ex)
			{
				// NT8 rebuilds this collection on the UI thread while pool threads
				// enumerate it ("Collection was modified").
				Log("ResolveInstrument: RolloverCollection enumeration threw for '"
					+ symbol + "': " + ex.Message);
				return null;
			}

			if (!found)
			{
				Log("ResolveInstrument: rollover table for '" + symbol
					+ "' has no window open on " + today.ToString("yyyy-MM-dd", inv)
					+ " (empty or unconfigured); falling through");
				return null;
			}

			var wanted = bestMonth.ToString("yyyy-MM", inv)
				+ " (window opened " + bestRoll.ToString("yyyy-MM-dd", inv) + ")";

			// Match on delivery month, not name: renderings differ per install.
			try
			{
				foreach (var i in Instrument.All)
				{
					if (i == null || i.MasterInstrument == null) continue;
					if (i.MasterInstrument.InstrumentType != InstrumentType.Future) continue;
					if (!string.Equals(i.MasterInstrument.Name, master.Name, StringComparison.OrdinalIgnoreCase)) continue;
					if (!IsRealContract(i)) continue;
					if (i.Expiry.Year != bestMonth.Year || i.Expiry.Month != bestMonth.Month) continue;
					if (!IsUnexpired(i, today))
					{
						Log("ResolveInstrument: rollover table for '" + symbol + "' names " + wanted
							+ " but " + DescribeInstrument(i) + " has expired — the table is STALE"
							+ " (add the next rollover row in Tools > Instruments); falling through");
						return null;
					}
					Log("ResolveInstrument: rollover table → delivery month " + wanted
						+ " → " + DescribeInstrument(i));
					return i;
				}
			}
			catch (Exception ex)
			{
				// A name-probe guess would carry the table's authority, which it no longer has.
				Log("ResolveInstrument: delivery-month scan threw for '" + symbol + "': " + ex.Message);
				return null;
			}

			// Fallback: ask NT by name, in case the month is not enumerated.
			foreach (var cand in ContractNameCandidates(master.Name, bestMonth))
			{
				Instrument inst = null;
				try { inst = Instrument.GetInstrument(cand); }
				catch (Exception ex) { Log("ResolveInstrument: GetInstrument('" + cand + "') threw: " + ex.Message); continue; }
				if (IsUnexpired(inst, today) && inst.Expiry.Year == bestMonth.Year && inst.Expiry.Month == bestMonth.Month)
				{
					Log("ResolveInstrument: rollover table → '" + cand + "' " + wanted
						+ " → " + DescribeInstrument(inst));
					return inst;
				}
			}

			Log("ResolveInstrument: rollover table wanted delivery month " + wanted
				+ " for '" + symbol + "' but no instrument matched; falling through");
			return null;
		}

		// Read-path resolution: any real contract, best authority first.
		private Instrument ResolveInstrument(string symbol)
		{
			return Resolve(symbol).Instrument;
		}

		private Resolution Resolve(string symbol)
		{
			if (string.IsNullOrEmpty(symbol)) return Resolution.None;

			var today = SessionDateEastern();
			var inv   = System.Globalization.CultureInfo.InvariantCulture;
			var key   = symbol + "|" + today.ToString("yyyy-MM-dd", inv);

			// Attested answers only: a guess must stay retryable, never served as fact.
			Resolution cached;
			if (instrumentCache.TryGetValue(key, out cached)) return cached;

			var r = ResolveUncached(symbol, today);
			if (r.Instrument != null && r.Attested) instrumentCache[key] = r;
			return r;
		}

		private Resolution ResolveUncached(string symbol, DateTime today)
		{
			// 1) The caller picked the expiry: honour it, never substitute.
			if (IsFullContractName(symbol))
			{
				Instrument inst = null;
				try { inst = Instrument.GetInstrument(symbol); }
				catch (Exception ex) { Log("ResolveInstrument: GetInstrument('" + symbol + "') threw: " + ex.Message); }
				if (IsRealContract(inst))
				{
					Log("ResolveInstrument: explicit contract '" + symbol + "' → " + DescribeInstrument(inst));
					return new Resolution
					{
						Instrument = inst, Source = "explicit", Attested = true,
						Tradable = IsUnexpired(inst, today),
					};
				}
				Log("ResolveInstrument: explicit contract '" + symbol
					+ "' not found; refusing to substitute the front month");
				return Resolution.None;
			}

			// 2) NT8's rollover table decides the front month.
			var byTable = FrontMonthFromRollovers(symbol, today);
			if (byTable != null)
				return new Resolution { Instrument = byTable, Source = "rollover-table", Attested = true, Tradable = true };

			// 3) Soonest unexpired contract; cannot know a roll has been scheduled.
			try
			{
				Instrument frontMonth = null;
				int scanned = 0, candidates = 0;
				foreach (var i in Instrument.All)
				{
					scanned++;
					if (i == null || i.MasterInstrument == null) continue;
					if (i.MasterInstrument.InstrumentType != InstrumentType.Future) continue;
					if (!string.Equals(i.MasterInstrument.Name, symbol, StringComparison.OrdinalIgnoreCase)) continue;
					if (!IsUnexpired(i, today)) continue;
					candidates++;
					if (frontMonth == null || i.Expiry < frontMonth.Expiry) frontMonth = i;
				}
				Log("ResolveInstrument: scanned " + scanned + " instruments, "
					+ candidates + " unexpired candidate(s) for '" + symbol + "'");
				if (frontMonth != null)
				{
					Log("ResolveInstrument: front month from expiry scan, NOT the rollover"
						+ " table → " + DescribeInstrument(frontMonth));
					return new Resolution { Instrument = frontMonth, Source = "expiry-scan", Attested = false, Tradable = true };
				}
			}
			catch (Exception ex)
			{
				Log("ResolveInstrument: Instrument.All scan threw: " + ex.Message);
			}

			// 4) Probe computed names, for a contract NT8 knows but does not
			//    enumerate in Instrument.All.
			try
			{
				for (int offset = 0; offset < 24; offset++)
				{
					var month = new DateTime(today.Year, today.Month, 1).AddMonths(offset);
					foreach (var cand in ContractNameCandidates(symbol, month))
					{
						Instrument inst = null;
						try { inst = Instrument.GetInstrument(cand); }
						catch (Exception ex) { Log("ResolveInstrument: GetInstrument('" + cand + "') threw: " + ex.Message); continue; }
						if (IsUnexpired(inst, today))
						{
							Log("ResolveInstrument: computed contract '" + cand + "' → " + DescribeInstrument(inst));
							return new Resolution { Instrument = inst, Source = "name-probe", Attested = false, Tradable = true };
						}
					}
				}
				Log("ResolveInstrument: no unexpired contract found for '" + symbol + "' after 24 monthly probes");
			}
			catch (Exception ex)
			{
				Log("ResolveInstrument: computed-contract fallback threw: " + ex.Message);
			}

			return Resolution.None;
		}

		// Risk-adding: a guess here is a fill on the wrong contract. Refuses with
		// instrument-not-found, which the server treats as a definitive block.
		private Instrument RequireTradable(string symbol, string id, string op)
		{
			var r = Resolve(symbol);
			if (r.Instrument == null)
			{
				SendErrorResponse(id, "could not resolve instrument for symbol: " + symbol, "instrument-not-found");
				return null;
			}
			if (!r.Attested || !r.Tradable)
			{
				var why = !r.Attested
					? "resolved only by " + r.Source + " (rollover table unreadable) — not guessing a contract for a risk-adding order"
					: "is past its last trading day";
				SendErrorResponse(id, op + " refused: " + symbol + " → " + DescribeInstrument(r.Instrument)
					+ " " + why, "instrument-not-found");
				Log(op + " REFUSED symbol=" + symbol + " source=" + r.Source
					+ " attested=" + r.Attested + " tradable=" + r.Tradable);
				return null;
			}
			return r.Instrument;
		}

		// Arming preflight: what a bare symbol binds now, and on whose authority.
		private void HandleResolveInstrument(IDictionary<string, object> obj)
		{
			var id     = GetString(obj, "id");
			var symbol = GetString(obj, "symbol");
			if (string.IsNullOrEmpty(id)) { Log("resolve_instrument missing id; dropping"); return; }
			if (string.IsNullOrEmpty(symbol))
			{
				SendErrorResponse(id, "resolve_instrument missing required field: symbol");
				return;
			}
			var r = Resolve(symbol);
			string contract = null;
			try { contract = r.Instrument != null ? r.Instrument.FullName : null; }
			catch { /* transient — report no contract */ }
			var payload = new Dictionary<string, object>
			{
				{ "v",        1 },
				{ "id",       id },
				{ "type",     "resolve_instrument_result" },
				{ "symbol",   symbol },
				{ "contract", contract },
				{ "source",   r.Source },
				{ "attested", r.Attested },
				{ "tradable", r.Tradable },
			};
			var rollovers = r.Instrument != null ? RolloverWindows(r.Instrument) : null;
			if (rollovers != null) payload["rollovers"] = rollovers;
			SendFireAndForget(Json.Serialize(payload),
				"resolve_instrument_result " + symbol + " → " + (contract ?? "<none>") + " (" + r.Source + ")");
		}

		// Risk-reducing: a bare symbol is every contract of the master the account
		// is exposed to, plus the front — a rolled-away position must stay reachable.
		private static List<Instrument> ExposureOfMaster(Account account, string symbol, Instrument front)
		{
			var byName = new Dictionary<string, Instrument>(StringComparer.Ordinal);
			var master = symbol;
			try
			{
				if (front != null)
				{
					byName[front.FullName] = front;
					if (front.MasterInstrument != null) master = front.MasterInstrument.Name;
				}
			}
			catch { /* transient — keep symbol as the master name */ }

			try
			{
				var positions = new List<Position>();
				lock (account.Positions)
				{
					foreach (var p in account.Positions) if (p != null) positions.Add(p);
				}
				foreach (var p in positions)
				{
					try
					{
						if (p.MarketPosition == MarketPosition.Flat || p.Quantity == 0) continue;
						var i = p.Instrument;
						if (i == null || i.MasterInstrument == null) continue;
						if (string.Equals(i.MasterInstrument.Name, master, StringComparison.OrdinalIgnoreCase))
							byName[i.FullName] = i;
					}
					catch { /* position mid-teardown */ }
				}
			}
			catch { /* fall through with what we have */ }

			try
			{
				var orders = new List<Order>();
				lock (account.Orders)
				{
					foreach (var o in account.Orders) if (o != null) orders.Add(o);
				}
				foreach (var o in orders)
				{
					try
					{
						if (Order.IsTerminalState(o.OrderState)) continue;
						var i = o.Instrument;
						if (i == null || i.MasterInstrument == null) continue;
						if (string.Equals(i.MasterInstrument.Name, master, StringComparison.OrdinalIgnoreCase))
							byName[i.FullName] = i;
					}
					catch { /* order mid-teardown */ }
				}
			}
			catch { /* fall through with what we have */ }

			return new List<Instrument>(byName.Values);
		}

		private static string DescribeTargets(List<Instrument> targets, string fallback)
		{
			var names = new List<string>();
			foreach (var t in targets)
			{
				try { names.Add(t.FullName ?? fallback); } catch { names.Add(fallback); }
			}
			return names.Count == 0 ? fallback : string.Join(", ", names);
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

		// The table NT8 merged across, sent with every candles_response. Null =
		// read failed; empty = NT8 has no table and so did not merge.
		private static List<object> RolloverWindows(Instrument instrument)
		{
			var inv  = System.Globalization.CultureInfo.InvariantCulture;
			var rows = new List<object>();
			try
			{
				var master = instrument != null ? instrument.MasterInstrument : null;
				var coll   = master != null ? master.RolloverCollection : null;
				if (coll == null) return null;
				foreach (var r in coll)
				{
					if (r == null || r.ContractMonth == DateTime.MinValue || r.Date == DateTime.MinValue) continue;
					rows.Add(new Dictionary<string, object>
					{
						{ "contractMonth", r.ContractMonth.ToString("yyyy-MM-dd", inv) },
						{ "rolloverDate",  r.Date.ToString("yyyy-MM-dd", inv) },
					});
				}
			}
			catch (Exception ex)
			{
				// Never a partial table.
				Log("RolloverWindows threw: " + ex.Message);
				return null;
			}
			return rows;
		}

		// UseGlobalSettings / UseDefault resolved through Tools > Options > Market
		// data. On failure returns UseDefault, which PriceBasisOf maps to unknown.
		private static MergePolicy EffectiveMergePolicy(BarsRequest request)
		{
			try
			{
				var policy = request.MergePolicy;
				if (policy == MergePolicy.UseGlobalSettings || policy == MergePolicy.UseDefault)
					policy = Core.Globals.MarketDataOptions.GlobalMergePolicy;
				return policy;
			}
			catch (Exception ex)
			{
				Log("EffectiveMergePolicy failed: " + ex.Message);
				return MergePolicy.UseDefault;
			}
		}

		// Price basis of the bars a policy produces. MergeBackAdjusted shifts ALL
		// history by the accumulated roll gaps, so those bars are not comparable
		// with as-traded ones and must never land in the same cache unlabelled.
		// "unknown" is preserved as such rather than assumed safe.
		private static string PriceBasisOf(MergePolicy policy)
		{
			switch (policy)
			{
				case MergePolicy.MergeBackAdjusted:    return "back_adjusted";
				case MergePolicy.MergeNonBackAdjusted: return "as_traded";
				// One expiry, never stitched, so nothing is adjusted — but it is
				// also not continuous: a range spanning a roll silently returns
				// the current contract's own older prices.
				case MergePolicy.DoNotMerge:           return "as_traded";
				default:                               return "unknown";
			}
		}

		// Serialize a template's NT8-declared holidays (fully closed) and
		// partial holidays (early close / late begin).
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

			TradingHours nt8TradingHours;
			string       nt8TemplateName;
			string       thError;
			if (!TryResolveTradingHours(tradingHoursTemplate, GetString(obj, "nt8TradingHours"),
				out nt8TradingHours, out nt8TemplateName, out thError))
			{
				SendErrorResponse(id, thError);
				return;
			}

			var holidays = new List<object>();
			if (nt8TradingHours.Holidays != null)
			{
				foreach (var kvp in nt8TradingHours.Holidays)
				{
					holidays.Add(new Dictionary<string, object>
					{
						// InvariantCulture, same reason as above.
						{ "date",        kvp.Key.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) },
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
					var entry = new Dictionary<string, object>
					{
						{ "date",         kvp.Key.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) },
						{ "isEarlyClose", partial != null && partial.IsEarlyEnd },
						{ "isLateBegin",  partial != null && partial.IsLateBegin },
						{ "description",  partial != null && partial.Description != null ? partial.Description : "" },
					};
					AddPartialHolidayTimes(entry, kvp.Key, partial, nt8TradingHours.TimeZoneInfo);
					partialHolidays.Add(entry);
				}
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",               1 },
				{ "id",              id },
				{ "type",            "session_calendar_response" },
				{ "template",        nt8TemplateName },
				{ "holidays",        holidays },
				{ "partialHolidays", partialHolidays },
			};
			AddSessionRows(nt8TradingHours, payload);
			SendFireAndForget(Json.Serialize(payload),
				"session_calendar_response id=" + id
				+ " holidays=" + holidays.Count + " partial=" + partialHolidays.Count);
		}

		// Shared TF / trading-hours resolution — one impl for request_candles and
		// subscribe_bars so the two paths cannot drift.

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
			// 'd' => BarsPeriodType.Day: NT8 builds one bar per session using the
			// SAME TradingHours template resolved below, which is what makes a
			// daily bar line up with the server's session-days.
			if (unit == 's')      periodType = BarsPeriodType.Second;
			else if (unit == 'd') periodType = BarsPeriodType.Day;
			else                  periodType = BarsPeriodType.Minute;
			periodValue       = n;
			resolvedTimeframe = timeframe;
			return true;
		}

		// NT8 must hold a template of exactly the resolved name: never fetch under other hours.
		private static bool TryResolveTradingHours(string tradingHoursTemplate, string requestedNt8Name,
			out TradingHours tradingHours, out string nt8TemplateName, out string error)
		{
			tradingHours    = null;
			error           = null;
			nt8TemplateName = requestedNt8Name;
			if (string.IsNullOrEmpty(nt8TemplateName)
				&& !TRADING_HOURS_MAP.TryGetValue(tradingHoursTemplate, out nt8TemplateName))
			{
				var knownKeys = new StringBuilder();
				foreach (var k in TRADING_HOURS_MAP.Keys)
				{
					if (knownKeys.Length > 0) knownKeys.Append(", ");
					knownKeys.Append(k);
				}
				error = "Unknown tradingHoursTemplate: '" + tradingHoursTemplate
					+ "' and the request names no NT8 template. Built in: " + knownKeys.ToString()
					+ ". Set nt8TradingHours on the server's session template.";
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
			if (tradingHours == null
				|| !string.Equals(tradingHours.Name, nt8TemplateName, StringComparison.Ordinal))
			{
				tradingHours = null;
				error = "NT8 has no TradingHours template named '" + nt8TemplateName
					+ "' (for '" + tradingHoursTemplate
					+ "'). Check 'Tools → Trading Hours' in NT8; the name must match exactly.";
				return false;
			}
			return true;
		}

		// All or nothing: the server compares hours only when every field arrives.
		private static void AddSessionRows(TradingHours tradingHours, Dictionary<string, object> payload)
		{
			try
			{
				var tz = tradingHours.TimeZoneInfo;
				if (tz == null || tradingHours.Sessions == null) return;
				var rows = new List<object>();
				for (int i = 0; i < tradingHours.Sessions.Count; i++)
				{
					var s = tradingHours.Sessions[i];
					rows.Add(new Dictionary<string, object>
					{
						{ "beginDay",   (int) s.BeginDay },
						{ "beginTime",  s.BeginTime },
						{ "endDay",     (int) s.EndDay },
						{ "endTime",    s.EndTime },
						{ "tradingDay", (int) s.TradingDay },
					});
				}
				payload["timeZone"]         = tz.Id;
				payload["utcOffsetMinutes"] = (int) tz.BaseUtcOffset.TotalMinutes;
				payload["observesDst"]      = tz.SupportsDaylightSavingTime;
				payload["sessions"]         = rows;
			}
			catch (Exception ex)
			{
				Log("session rows unreadable for '" + tradingHours.Name + "': " + ex.Message);
			}
		}

		// An early close ends on the holiday's own date; a late begin may start the evening before.
		private static void AddPartialHolidayTimes(Dictionary<string, object> entry, DateTime date,
			PartialHoliday partial, TimeZoneInfo tz)
		{
			if (partial == null || partial.Constraint == null || tz == null) return;
			try
			{
				var c = partial.Constraint;
				if (partial.IsEarlyEnd && c.EndDay == date.DayOfWeek)
				{
					var closeUnix = ConstraintUnixSeconds(date, c.EndTime, tz);
					if (closeUnix.HasValue) entry["closeUnix"] = closeUnix.Value;
				}
				if (partial.IsLateBegin)
				{
					var beginDate = date.AddDays(-(((int) date.DayOfWeek - (int) c.BeginDay + 7) % 7));
					var openUnix  = ConstraintUnixSeconds(beginDate, c.BeginTime, tz);
					if (openUnix.HasValue) entry["openUnix"] = openUnix.Value;
				}
			}
			catch (Exception ex)
			{
				Log("partial holiday times unreadable for " + date.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message);
			}
		}

		// Constraint times are HHMM in the template's own time zone.
		private static long? ConstraintUnixSeconds(DateTime day, int hhmm, TimeZoneInfo tz)
		{
			int hours = hhmm / 100, minutes = hhmm % 100;
			if (hhmm < 0 || hours > 24 || minutes > 59 || (hours == 24 && minutes != 0)) return null;
			var local = DateTime.SpecifyKind(day.Date, DateTimeKind.Unspecified).AddHours(hours).AddMinutes(minutes);
			return (long) (TimeZoneInfo.ConvertTimeToUtc(local, tz) - UnixEpoch).TotalSeconds;
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
			if (!TryResolveTradingHours(tradingHoursTemplate, GetString(obj, "nt8TradingHours"),
				out nt8TradingHours, out nt8TemplateName, out thError))
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

						SendCandlesResponse(id, symbol, resolvedTimeframe, candles,
							EffectiveMergePolicy(barsRequest), instrument.FullName,
							RolloverWindows(instrument));
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
			List<object> candles, MergePolicy mergePolicy, string contract, List<object> rollovers)
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
				{ "priceBasis",  PriceBasisOf(mergePolicy) },
				{ "mergePolicy", mergePolicy.ToString() },
				// Bound instrument only; per-bar labels come from rollovers.
				{ "contract",    contract },
			};
			if (rollovers != null) payload["rollovers"] = rollovers;
			SendFireAndForget(Json.Serialize(payload),
				"candles_response id=" + id + " count=" + candles.Count);
		}

		// request_ticks

		// Bump with the ".vN" of request_ticks in WriteCaps whenever the drop-file format changes.
		private const string TicksAddonVersion       = "2";
		private const string DefaultTickTradingHours = "Default 24 x 7";
		// ".noindex" keeps Spotlight out when a Mac host shares this folder.
		private const string TickDropFolder          = "mcp-ticks.noindex";
		private const long   TickMinGuestFreeMb      = 4096;
		private static readonly System.Text.RegularExpressions.Regex TickJobName =
			new System.Text.RegularExpressions.Regex(@"^[A-Za-z0-9-]{1,40}$");

		// One tick load at a time: after a timeout or a hub restart the hub sends
		// more while NT8 is still loading the last one.
		private readonly object tickSlotLock = new object();
		private string   tickSlotId;
		private string   tickSlotWhat;
		private DateTime tickSlotSinceUtc;

		// Null when taken; otherwise what holds the slot.
		private string TakeTickSlot(string id, string what)
		{
			lock (tickSlotLock)
			{
				if (tickSlotId != null)
					return "request " + tickSlotId + " (" + tickSlotWhat + "), started "
						+ (int) (DateTime.UtcNow - tickSlotSinceUtc).TotalMinutes + " min ago";
				tickSlotId       = id;
				tickSlotWhat     = what;
				tickSlotSinceUtc = DateTime.UtcNow;
				return null;
			}
		}

		private void ReleaseTickSlot(string id)
		{
			lock (tickSlotLock)
			{
				if (tickSlotId == id) tickSlotId = null;
			}
		}

		private sealed class TickDay
		{
			public string      Id;
			public Instrument  Instrument;
			public string      Stream;
			public string      DayText;
			public string      Dir;
			public string      Lookup;
			public TimeZoneInfo Tz;
			public long        DayFromTs;
			public long        DayToTs;
			public DateTime    StartedUtc;
			public long        MemoryBeforeMb;
			public long        GuestFreeBeforeMb;
			public BarsRequest Request;
		}

		private void HandleRequestTicks(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("request_ticks missing id; dropping"); return; }

			var inv            = System.Globalization.CultureInfo.InvariantCulture;
			var instrumentName = GetString(obj, "instrument");
			var stream         = GetString(obj, "stream");
			var dayText        = GetString(obj, "day");
			var job            = GetString(obj, "job");
			var lookup         = GetString(obj, "lookup") ?? "provider";
			var hoursName      = GetString(obj, "tradingHours") ?? DefaultTickTradingHours;
			var toOffsetDays   = GetInt(obj, "toOffsetDays") ?? 0;

			MarketDataType marketData;
			if (!TryTickMarketData(stream, out marketData))
			{
				SendErrorResponse(id, "request_ticks: stream must be prints, bid or ask, not '" + stream + "'");
				return;
			}
			DateTime day;
			if (!DateTime.TryParseExact(dayText, "yyyy-MM-dd", inv, System.Globalization.DateTimeStyles.None, out day))
			{
				SendErrorResponse(id, "request_ticks: day must be yyyy-MM-dd, not '" + dayText + "'");
				return;
			}
			if (string.IsNullOrEmpty(instrumentName) || job == null || !TickJobName.IsMatch(job)
				|| (lookup != "provider" && lookup != "repository") || (toOffsetDays != 0 && toOffsetDays != 1))
			{
				SendErrorResponse(id, "request_ticks: bad request (instrument='" + instrumentName + "', job='" + job
					+ "', lookup='" + lookup + "', toOffsetDays=" + toOffsetDays + ")");
				return;
			}

			var exposure = DescribeExposure();
			if (exposure != null)
			{
				SendErrorResponse(id, "request_ticks refused: NT8 is not flat (" + exposure + ")", "not_flat");
				return;
			}

			var r = Resolve(instrumentName);
			if (r.Instrument == null || r.Source != "explicit")
			{
				SendErrorResponse(id, "request_ticks: no NT8 instrument is named '" + instrumentName + "' (resolved by "
					+ r.Source + "); a tick fetch never picks a contract itself", "unknown_instrument");
				return;
			}

			var tz = GetConfiguredTimeZone();
			long dayFromTs, dayToTs;
			try
			{
				if (tz == null) throw new InvalidOperationException("the time zone in Tools > Options > General is unreadable");
				dayFromTs = LocalToTs(day, tz);
				dayToTs   = LocalToTs(day.AddDays(1), tz);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "request_ticks: NT8's time zone: " + ex.Message, "bad_time_zone");
				return;
			}

			TradingHours hours = null;
			try { hours = TradingHours.Get(hoursName); }
			catch (Exception ex) { Log("request_ticks: TradingHours.Get('" + hoursName + "') threw: " + ex.Message); }
			if (hours == null || !string.Equals(hours.Name, hoursName, StringComparison.Ordinal))
			{
				SendErrorResponse(id, "request_ticks: NT8 has no TradingHours template named '" + hoursName + "'");
				return;
			}

			// Below this, loading a day of ticks makes Windows page to disk.
			var guestFree = GuestFreeMb();
			if (guestFree < TickMinGuestFreeMb)
			{
				SendErrorResponse(id, "request_ticks refused: Windows has "
					+ (guestFree < 0 ? "an unreadable amount of" : guestFree + " MB of") + " physical memory available; a tick fetch needs "
					+ TickMinGuestFreeMb + " MB", "low_memory");
				return;
			}

			string dir;
			try
			{
				dir = Path.Combine(Globals.UserDataDir, TickDropFolder, job);
				Directory.CreateDirectory(dir);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "request_ticks: cannot create the drop folder: " + ex.Message, "io");
				return;
			}

			var t = new TickDay
			{
				Id = id, Instrument = r.Instrument, Stream = stream, DayText = dayText, Dir = dir, Lookup = lookup,
				Tz = tz, DayFromTs = dayFromTs, DayToTs = dayToTs,
				StartedUtc = DateTime.UtcNow, MemoryBeforeMb = ProcessMemoryMb(), GuestFreeBeforeMb = guestFree,
			};
			try
			{
				t.Request = new BarsRequest(r.Instrument, day, day.AddDays(toOffsetDays));
				t.Request.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1, MarketDataType = marketData };
				t.Request.TradingHours = hours;
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "request_ticks: BarsRequest construction failed: " + ex.Message, "bars_request_failed");
				return;
			}
			var mergeError = SetEnumProperty(t.Request, "MergePolicy", "DoNotMerge");
			if (mergeError != null)
			{
				try { t.Request.Dispose(); } catch { /* ignore */ }
				SendErrorResponse(id, "request_ticks: " + mergeError, "merge_policy");
				return;
			}
			var lookupError = SetEnumProperty(t.Request, "LookupPolicy", lookup == "repository" ? "Repository" : "Provider");
			if (lookupError != null)
			{
				try { t.Request.Dispose(); } catch { /* ignore */ }
				SendErrorResponse(id, "request_ticks: " + lookupError, "bars_request_failed");
				return;
			}

			Log("request_ticks id=" + id + " " + DescribeInstrument(r.Instrument) + " " + stream + " " + dayText
				+ " lookup=" + lookup + " hours='" + hoursName + "' toOffsetDays=" + toOffsetDays + " → " + dir);
			var holder = TakeTickSlot(id, r.Instrument.FullName + " " + stream + " " + dayText);
			if (holder != null)
			{
				try { t.Request.Dispose(); } catch { /* ignore */ }
				SendErrorResponse(id, "request_ticks refused: NT8 is still loading " + holder + "; one tick load at a time", "busy");
				return;
			}

			// Every path from here frees the slot before it replies: the hub sends the
			// next request as soon as it reads one.
			try
			{
				t.Request.Request((bars, errorCode, errorMessage) =>
				{
					if (errorCode != ErrorCode.NoError)
					{
						Log("request_ticks id=" + id + " errorCode=" + errorCode + " errorMessage=" + (errorMessage ?? "<null>")
							+ " | provider " + DescribeProviderState());
						try { t.Request.Dispose(); } catch { /* ignore */ }
						ReleaseTickSlot(id);
						SendErrorResponse(id, "request_ticks: BarsRequest failed: " + errorCode + " — " + errorMessage, "bars_request_failed");
						return;
					}
					// The row walk runs on a pool thread so NT8's callback thread is not held.
					Task.Run(() => WriteTickDay(t, bars));
				});
			}
			catch (Exception ex)
			{
				try { t.Request.Dispose(); } catch { /* ignore */ }
				ReleaseTickSlot(id);
				SendErrorResponse(id, "request_ticks: BarsRequest.Request threw: " + ex.Message, "bars_request_failed");
			}
		}

		private void WriteTickDay(TickDay t, BarsRequest loaded)
		{
			var inv  = System.Globalization.CultureInfo.InvariantCulture;
			var file = Path.Combine(t.Dir, t.Stream + "." + t.DayText + ".txt.gz");
			var part = file + ".part";
			// Sent from the finally block, once the slot is free.
			Action reply = null;
			try
			{
				var policy = EffectiveMergePolicy(t.Request);
				if (policy != MergePolicy.DoNotMerge)
				{
					reply = () => SendErrorResponse(t.Id, "request_ticks: NT8 served the request as " + policy + ", not DoNotMerge", "merge_policy");
					return;
				}

				var data   = loaded != null ? loaded.Bars : null;
				var count  = data != null ? data.Count : 0;
				var prints = t.Stream == "prints";
				long rows = 0, loadedRows = 0, sizeSum = 0, firstTs = 0, lastTs = 0, loadedFirst = 0, loadedLast = 0;
				long minuteKey = long.MinValue, offsetTicks = 0;
				var minuteBad = false;
				using (var fs = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None))
				using (var gz = new System.IO.Compression.GZipStream(fs, System.IO.Compression.CompressionLevel.Optimal))
				using (var w = new StreamWriter(gz, new UTF8Encoding(false), 1 << 20))
				{
					for (int i = 0; i < count; i++)
					{
						var local = data.GetTime(i);
						var key   = local.Ticks / TimeSpan.TicksPerMinute;
						if (key != minuteKey)
						{
							// Zones change offset on whole minutes, so one lookup per minute.
							var minute = new DateTime(key * TimeSpan.TicksPerMinute, DateTimeKind.Unspecified);
							minuteBad  = t.Tz.IsAmbiguousTime(minute) || t.Tz.IsInvalidTime(minute);
							if (!minuteBad) offsetTicks = minute.Ticks - TimeZoneInfo.ConvertTimeToUtc(minute, t.Tz).Ticks;
							minuteKey  = key;
						}
						if (minuteBad)
						{
							var why = "request_ticks: row " + i + " is at " + local.ToString("yyyy-MM-dd HH:mm:ss.fffffff", inv)
								+ ", which " + t.Tz.Id + " calls ambiguous or skipped";
							reply = () => SendErrorResponse(t.Id, why, "ambiguous_time");
							return;
						}
						var ts = local.Ticks - offsetTicks - UnixEpoch.Ticks;
						if (loadedRows == 0) loadedFirst = ts;
						loadedLast = ts;
						loadedRows++;
						if (ts < t.DayFromTs || ts >= t.DayToTs) continue;

						var volume = data.GetVolume(i);
						w.Write(ts.ToString(inv));
						w.Write(';');
						w.Write(TickPriceText(data.GetClose(i)));
						w.Write(';');
						w.Write(volume.ToString(inv));
						if (prints)
						{
							w.Write(';');
							w.Write(TickPriceText(data.GetBid(i)));
							w.Write(';');
							w.Write(TickPriceText(data.GetAsk(i)));
						}
						w.Write('\n');
						if (rows == 0) firstTs = ts;
						lastTs = ts;
						rows++;
						sizeSum += (long) volume;
					}
				}
				if (File.Exists(file)) File.Delete(file);
				if (rows > 0) File.Move(part, file);
				var memoryAfter = ProcessMemoryMb();
				var guestFreeAfter = GuestFreeMb();

				var payload = new Dictionary<string, object>
				{
					{ "v",                 1 },
					{ "id",                t.Id },
					{ "type",              "ticks_response" },
					{ "instrument",        t.Instrument.FullName },
					{ "stream",            t.Stream },
					{ "day",               t.DayText },
					{ "file",              rows > 0 ? file : null },
					{ "rows",              rows },
					{ "sizeSum",           sizeSum.ToString(inv) },
					{ "firstTs",           rows > 0 ? firstTs.ToString(inv) : null },
					{ "lastTs",            rows > 0 ? lastTs.ToString(inv) : null },
					{ "dayFromTs",         t.DayFromTs.ToString(inv) },
					{ "dayToTs",           t.DayToTs.ToString(inv) },
					{ "loadedRows",        loadedRows },
					{ "loadedFirstTs",     loadedRows > 0 ? loadedFirst.ToString(inv) : null },
					{ "loadedLastTs",      loadedRows > 0 ? loadedLast.ToString(inv) : null },
					{ "tickSize",          TickPriceText(t.Instrument.MasterInstrument.TickSize) },
					{ "mergePolicy",       policy.ToString() },
					{ "priceBasis",        PriceBasisOf(policy) },
					{ "lookup",            t.Lookup },
					{ "dataSource",        ClassifyDataSource() },
					{ "timeZone",          t.Tz.Id },
					{ "fetchedAt",         (t.StartedUtc.Ticks - UnixEpoch.Ticks).ToString(inv) },
					{ "elapsedMs",         (long) (DateTime.UtcNow - t.StartedUtc).TotalMilliseconds },
					{ "memoryBeforeMb",    t.MemoryBeforeMb },
					{ "memoryAfterMb",     memoryAfter },
					{ "guestFreeBeforeMb", t.GuestFreeBeforeMb },
					{ "guestFreeAfterMb",  guestFreeAfter },
					{ "addonVersion",      TicksAddonVersion },
				};
				Log("request_ticks id=" + t.Id + " wrote " + rows + " of " + loadedRows + " loaded rows"
					+ (rows > 0 ? " to " + file : "") + " in " + payload["elapsedMs"] + " ms, memory "
					+ t.MemoryBeforeMb + " → " + memoryAfter + " MB, Windows free " + t.GuestFreeBeforeMb + " → " + guestFreeAfter + " MB");
				var json  = Json.Serialize(payload);
				var label = "ticks_response id=" + t.Id + " " + t.Stream + " " + t.DayText + " rows=" + rows;
				reply = () => SendFireAndForget(json, label);
			}
			catch (IOException ex)
			{
				reply = () => SendErrorResponse(t.Id, "request_ticks: writing " + part + " failed: " + ex.Message, "io");
			}
			catch (UnauthorizedAccessException ex)
			{
				reply = () => SendErrorResponse(t.Id, "request_ticks: writing " + part + " failed: " + ex.Message, "io");
			}
			catch (Exception ex)
			{
				reply = () => SendErrorResponse(t.Id, "request_ticks failed: " + ex.Message);
			}
			finally
			{
				try { if (File.Exists(part)) File.Delete(part); } catch { /* reported above if it mattered */ }
				try { t.Request.Dispose(); } catch { /* ignore */ }
				ReleaseTickSlot(t.Id);
				if (reply != null) reply();
			}
		}

		private static bool TryTickMarketData(string stream, out MarketDataType type)
		{
			switch (stream)
			{
				case "prints": type = MarketDataType.Last; return true;
				case "bid":    type = MarketDataType.Bid;  return true;
				case "ask":    type = MarketDataType.Ask;  return true;
				default:       type = MarketDataType.Last; return false;
			}
		}

		// 100 ns since 1970 UTC; throws on a time the zone skips.
		private static long LocalToTs(DateTime local, TimeZoneInfo tz)
		{
			return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), tz).Ticks - UnixEpoch.Ticks;
		}

		// Exact decimal text, so the lake does the tick arithmetic; a value
		// decimal cannot hold goes as it is, for the lake to refuse.
		private static string TickPriceText(double value)
		{
			var inv = System.Globalization.CultureInfo.InvariantCulture;
			if (double.IsNaN(value) || double.IsInfinity(value) || Math.Abs(value) >= 1e15) return value.ToString("R", inv);
			return ((decimal) value).ToString(inv);
		}

		// Set by name, so the file compiles whatever this NT8 build calls the enum types.
		private static string SetEnumProperty(object target, string property, string value)
		{
			try
			{
				var prop = target.GetType().GetProperty(property);
				if (prop == null || !prop.CanWrite) return "BarsRequest has no settable " + property;
				prop.SetValue(target, Enum.Parse(prop.PropertyType, value), null);
				return null;
			}
			catch (Exception ex)
			{
				return "could not set " + property + " to " + value + ": " + ex.Message;
			}
		}

		private static long ProcessMemoryMb()
		{
			try
			{
				using (var p = System.Diagnostics.Process.GetCurrentProcess())
					return p.PrivateMemorySize64 / (1024 * 1024);
			}
			catch { return -1; }
		}

		[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
		private sealed class MemoryStatusEx
		{
			public uint  Length = (uint) System.Runtime.InteropServices.Marshal.SizeOf(typeof(MemoryStatusEx));
			public uint  MemoryLoad;
			public ulong TotalPhys;
			public ulong AvailPhys;
			public ulong TotalPageFile;
			public ulong AvailPageFile;
			public ulong TotalVirtual;
			public ulong AvailVirtual;
			public ulong AvailExtendedVirtual;
		}

		[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
		[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
		private static extern bool GlobalMemoryStatusEx([System.Runtime.InteropServices.In, System.Runtime.InteropServices.Out] MemoryStatusEx buffer);

		private static long GuestFreeMb()
		{
			try
			{
				var status = new MemoryStatusEx();
				return GlobalMemoryStatusEx(status) ? (long) (status.AvailPhys / (1024 * 1024)) : -1;
			}
			catch (Exception) { return -1; }
		}

		// Null only when every account is flat with no working order; fails closed.
		private static string DescribeExposure()
		{
			var open = new List<string>();
			try
			{
				var accounts = new List<Account>();
				lock (Account.All)
				{
					foreach (var a in Account.All) if (a != null) accounts.Add(a);
				}
				foreach (var a in accounts)
				{
					var positions = new List<Position>();
					lock (a.Positions)
					{
						foreach (var p in a.Positions) if (p != null) positions.Add(p);
					}
					foreach (var p in positions)
					{
						if (p.MarketPosition == MarketPosition.Flat || p.Quantity == 0) continue;
						open.Add(a.Name + " " + (p.Instrument != null ? p.Instrument.FullName : "?") + " " + p.MarketPosition + " " + p.Quantity);
					}
					var orders = new List<Order>();
					lock (a.Orders)
					{
						foreach (var o in a.Orders) if (o != null) orders.Add(o);
					}
					foreach (var o in orders)
					{
						if (Order.IsTerminalState(o.OrderState)) continue;
						open.Add(a.Name + " order '" + o.Name + "' " + o.OrderState);
					}
				}
			}
			catch (Exception ex)
			{
				return "accounts unreadable: " + ex.Message;
			}
			return open.Count == 0 ? null : string.Join("; ", open);
		}

		// live bar subscription state

		private const int LiveSeedBarsBack      = 30;   // enough to establish the index baseline
		private const int LiveSendQueueCapacity = 2048; // beyond this, bars drop (TS-side heal recovers)
		private const int BackfillThresholdBars = 2;    // older than 2 bar-widths at emit => backfill:true
		// ...but never tighter than this — at 1s the bar-width window alone is 2
		// SECONDS, which would mistag live bars backfill:true on ordinary emit
		// latency and silently stall consumers that skip stale closes.
		private const int BackfillThresholdMinSeconds = 30;

		private class LiveSub
		{
			public string      Key;        // symbol + "|" + timeframe
			public string      Symbol;     // roster symbol, e.g. "MNQ"
			public string      Timeframe;  // "1s" | "5s" | "15s" | "1m" | "5m" | "15m"
			public string      TradingHoursTemplate; // internal key, for reconnect re-resolution
			public string      Nt8TradingHours;      // NT8 name the server sent; null = use the map
			public int         TfSeconds;
			public Instrument  Instrument;
			public string      Source;     // how Instrument was chosen — see Resolution
			public bool        Attested;
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

		// live bar subscriptions — one BarsRequest per (symbol, timeframe). Close
		// detection is index-advance: when Update's MaxIndex passes the high-water
		// mark, every index in between just closed (never assume MaxIndex-1).
		// Payloads build under liveLock, send via the ordered queue.

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
			string contract, string source, bool attested,
			int seedCount, long seedLastTs, bool alreadyActive)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",             1 },
				{ "id",            id },
				{ "type",          "subscribe_ack" },
				{ "symbol",        symbol },
				{ "timeframe",     timeframe },
				{ "contract",      contract },
				{ "source",        source },
				{ "attested",      attested },
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
			if (periodType == BarsPeriodType.Day)
			{
				// A Day bar closes once per session, and the tfSeconds math plus
				// the server's gap/heal machinery below are built on intraday
				// grids. Daily is fetched, not streamed.
				SendErrorResponse(id, "subscribe_bars does not support '" + timeframe
					+ "': daily bars are historical-fetch only. Use request_candles.");
				return;
			}

			var          requestedNt8Name = GetString(obj, "nt8TradingHours");
			TradingHours tradingHours;
			string       nt8TemplateName;
			string       thError;
			if (!TryResolveTradingHours(tradingHoursTemplate, requestedNt8Name, out tradingHours,
				out nt8TemplateName, out thError))
			{
				SendErrorResponse(id, thError);
				return;
			}

			var resolution = Resolve(symbol);
			var instrument = resolution.Instrument;
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
							sub.Instrument.FullName, sub.Source, sub.Attested, 0, 0, true);
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
					Nt8TradingHours      = requestedNt8Name,
					TfSeconds            = tfSeconds,
					Instrument           = instrument,
					Source               = resolution.Source,
					Attested             = resolution.Attested,
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
									sub.Instrument.FullName, sub.Source, sub.Attested, seedCount, seedLastTs, false);
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
					// Live bars land in the same table as historical ones, so they
					// carry the same label. The two policies agree on the front
					// month (back-adjustment leaves the current contract
					// unshifted) — label it anyway, so a later policy change shows.
					var barBasis = sub.Request != null
						? PriceBasisOf(EffectiveMergePolicy(sub.Request))
						: "unknown";

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
							{ "priceBasis", barBasis },
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
						var staleAfter = Math.Max(
							(long) BackfillThresholdBars * sub.TfSeconds,
							(long) BackfillThresholdMinSeconds);
						if (nowUnix - ts > staleAfter)
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

		// Subs bind one instrument for life; NT8 rolls without them. Once per
		// session date and on hello, re-create any whose attested front month
		// moved. Never onto a guess.
		private void MaybeRebindOnSessionChange(string why)
		{
			var inv = System.Globalization.CultureInfo.InvariantCulture;
			var sd  = SessionDateEastern().ToString("yyyy-MM-dd", inv);
			if (string.Equals(sd, lastRebindSessionDate, StringComparison.Ordinal)) return;
			lastRebindSessionDate = sd;
			Task.Run(() =>
			{
				try { RebindRolledSubs(why + " " + sd); }
				catch (Exception ex) { Log("rebind failed: " + ex.Message); }
			});
		}

		private void RebindRolledSubs(string why)
		{
			lock (recreateGate)
			{
				List<LiveSub> snapshot;
				lock (liveLock) { snapshot = new List<LiveSub>(liveSubs.Values); }
				foreach (var sub in snapshot)
				{
					Resolution r;
					try { r = Resolve(sub.Symbol); }
					catch (Exception ex) { Log("rebind " + sub.Key + ": resolve threw: " + ex.Message); continue; }
					if (r.Instrument == null || !r.Attested) continue;

					string was, now;
					try
					{
						was = sub.Instrument != null ? sub.Instrument.FullName : null;
						now = r.Instrument.FullName;
					}
					catch { continue; }
					if (string.Equals(was, now, StringComparison.Ordinal)) continue;

					Log("rebind " + sub.Key + " (" + why + "): " + was + " → " + now + " per NT8's rollover table");
					DetachAndDispose(sub);

					BarsPeriodType periodType;
					int            periodValue;
					string         resolvedTf;
					string         tfError;
					if (!TryResolveBarsPeriod(sub.Timeframe, out periodType, out periodValue,
						out resolvedTf, out tfError))
					{
						Log("rebind " + sub.Key + " failed to re-resolve TF: " + tfError);
						lock (liveLock) { liveSubs.Remove(sub.Key); }
						continue;
					}
					TradingHours tradingHours;
					string       nt8TemplateName;
					string       thError;
					if (!TryResolveTradingHours(sub.TradingHoursTemplate, sub.Nt8TradingHours, out tradingHours,
						out nt8TemplateName, out thError))
					{
						Log("rebind " + sub.Key + " failed to re-resolve TradingHours: " + thError);
						lock (liveLock) { liveSubs.Remove(sub.Key); }
						continue;
					}
					lock (liveLock)
					{
						sub.Instrument = r.Instrument;
						sub.Source     = r.Source;
						sub.Attested   = r.Attested;
						sub.Seeded     = false;
					}
					StartLiveRequest(sub, periodType, periodValue, tradingHours, false);
				}
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
				if (!TryResolveTradingHours(sub.TradingHoursTemplate, sub.Nt8TradingHours, out tradingHours,
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
	}
}
