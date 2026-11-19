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
		// position tracking state — read-only observation, never creates/changes/
		// cancels orders. posLock guards the wired set, streaming flag, and the seq
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

		// account / position tracking — read-only observation of Account.All.
		// WireAccounts() reconciles per-account handlers against Account.All (re-run
		// on AccountStatusUpdate and provider reconnect); position_sync re-anchors
		// the server after subscribe / reconnect / roster change.
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

		// position event handlers (NT threads; must never throw)

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

		// payload builders (all reads best-effort)

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

		// position request handlers (Task.Run context)

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

		// order placement (write path) — the KEYSTONE safety gate, independent of
		// the TS-side gate and (no C# compiler on the trading machine) not
		// recompilable away by an agent. Fails closed: missing/garbled
		// trading.config.json, disabled flag, off-allow-list account, or over-cap
		// quantity all reject before Submit(). Idempotency: a repeated
		// clientOrderId replays the prior ack instead of firing a second order.

		private const string TradingConfigFileName = "trading.config.json";

		private readonly object orderLock = new object();
		private readonly Dictionary<string, SubmittedOrder> submittedOrders =
			new Dictionary<string, SubmittedOrder>(StringComparer.Ordinal);

		private class SubmittedOrder
		{
			public string Contract;
			public string OrderId;
			public string State;
			// Tick-rounded prices; 0 = n/a. Kept so a dedup replay echoes them.
			public double LimitPrice;
			public double StopPrice;
			// false = in-flight reservation (Submit() not yet succeeded);
			// true = real submitted order whose ack can be replayed.
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
			// NT8 has no FOK; Ioc is the closest primitive.
			if (string.Equals(s, "Ioc", StringComparison.OrdinalIgnoreCase)) { t = TimeInForce.Ioc; return true; }
			return false;
		}

		// Risk-reducing ops (cancel_order / cancel_all / flatten): allow-list
		// membership ONLY — deliberately ignores `enabled`/maxQty so these
		// exposure-reducing ops keep working through a kill-switch. Fails
		// closed: null gate (missing/garbled config) => no allow-list => block.
		private static bool RiskReducingAllowed(TradingGateConfig gate, string accountName)
		{
			return gate != null && gate.allowAccounts != null && gate.allowAccounts.Contains(accountName);
		}

		// Prefer a live (non-terminal) match; else return the newest terminal one
		// so the caller can report already-terminal + which state it ended in.
		private static Order FindWorkingOrderByName(Account a, string name)
		{
			var matches = new List<Order>();
			lock (a.Orders)
			{
				foreach (var o in a.Orders)
				{
					if (o == null) continue;
					try { if (string.Equals(o.Name, name, StringComparison.Ordinal)) matches.Add(o); }
					catch { /* order mid-teardown */ }
				}
			}
			Order newestTerminal = null;
			foreach (var o in matches)
			{
				try
				{
					if (!Order.IsTerminalState(o.OrderState)) return o;
					if (newestTerminal == null || o.Time > newestTerminal.Time) newestTerminal = o;
				}
				catch { /* transient — skip this candidate */ }
			}
			return newestTerminal;
		}

		// Brokers reject off-tick prices; round before use, echo effective in ack.
		private static double RoundToTick(Instrument inst, double price)
		{
			if (!(price > 0)) return price;
			try { return inst.MasterInstrument.RoundToTickSize(price); }
			catch { return price; }
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
							SendOrderAck(id, clientOrderId, prior.Contract, prior.OrderId, prior.State,
								prior.LimitPrice, prior.StopPrice, true);
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

				var instrument = RequireTradable(symbol, id, "place_order");
				if (instrument == null) return;

				// Round to tick before use; the ack echoes the effective values.
				limitPrice = RoundToTick(instrument, limitPrice);
				stopPrice  = RoundToTick(instrument, stopPrice);

				Order order;
				try
				{
					order = account.CreateOrder(
						instrument, action, orderType, OrderEntry.Automated, tif,
						quantity, limitPrice, stopPrice,
						"",              // oco — single order, no OCO link (see HandlePlaceOco)
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
					submittedOrders[clientOrderId] = new SubmittedOrder
					{
						Contract = contract, OrderId = orderId, State = state,
						LimitPrice = limitPrice, StopPrice = stopPrice, Completed = true,
					};
				}

				Log("place_order SUBMITTED account=" + accountName + " " + actionStr + " " + quantity
					+ " " + contract + " type=" + typeStr + " coid=" + clientOrderId + " state=" + state);
				SendOrderAck(id, clientOrderId, contract, orderId, state, limitPrice, stopPrice, false);
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
			string orderId, string state, double limitPrice, double stopPrice, bool deduped)
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
			// Effective (tick-rounded) prices; 0 = not applicable, key omitted.
			if (limitPrice > 0) payload["limitPrice"] = limitPrice;
			if (stopPrice  > 0) payload["stopPrice"]  = stopPrice;
			SendFireAndForget(Json.Serialize(payload), "order_ack coid=" + clientOrderId + " id=" + id);
		}

		// order management — same keystone rules as HandlePlaceOrder: gate re-read
		// fresh per request; risk-ADDING ops (place_oco, change_order) take the
		// full check (enabled + allow-list + maxQty), risk-REDUCING ops take
		// RiskReducingAllowed only; every price tick-rounded before use and echoed.

		private void HandlePlaceOco(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("place_oco missing id; dropping"); return; }

			// BOTH leg names reserved/released as one unit. reserved: placeholders
			// inserted for both. committed: Submit() succeeded, reservations become
			// replayable. ambiguous: Submit() threw, keep reservations so a same-id
			// retry is refused. finally releases both only when none of these hold.
			string stopClientOrderId   = null;
			string targetClientOrderId = null;
			bool   reserved  = false;
			bool   committed = false;
			bool   ambiguous = false;

			try
			{
				var accountName = GetString(obj, "account");
				var symbol      = GetString(obj, "symbol");
				var actionStr   = GetString(obj, "action");
				var tifStr      = GetString(obj, "tif");
				var ocoId       = GetString(obj, "ocoId");
				stopClientOrderId   = GetString(obj, "stopClientOrderId");
				targetClientOrderId = GetString(obj, "targetClientOrderId");
				var qtyN        = GetInt(obj, "quantity");
				var stopPrice   = GetDouble(obj, "stopPrice");
				var limitPrice  = GetDouble(obj, "limitPrice");

				// Pre-reservation validation — certainly not submitted.
				if (string.IsNullOrEmpty(accountName))         { SendErrorResponse(id, "place_oco missing account",             "invalid-params"); return; }
				if (string.IsNullOrEmpty(symbol))              { SendErrorResponse(id, "place_oco missing symbol",              "invalid-params"); return; }
				if (string.IsNullOrEmpty(ocoId))               { SendErrorResponse(id, "place_oco missing ocoId",               "invalid-params"); return; }
				if (string.IsNullOrEmpty(stopClientOrderId))   { SendErrorResponse(id, "place_oco missing stopClientOrderId",   "invalid-params"); return; }
				if (string.IsNullOrEmpty(targetClientOrderId)) { SendErrorResponse(id, "place_oco missing targetClientOrderId", "invalid-params"); return; }
				if (!qtyN.HasValue || qtyN.Value <= 0)         { SendErrorResponse(id, "place_oco quantity must be a positive integer", "invalid-params"); return; }
				if (!(stopPrice > 0))                          { SendErrorResponse(id, "place_oco requires a positive stopPrice",  "invalid-params"); return; }
				if (!(limitPrice > 0))                         { SendErrorResponse(id, "place_oco requires a positive limitPrice", "invalid-params"); return; }
				// Stop-vs-limit side correctness is NOT checked — NT8/broker owns that.
				var quantity = qtyN.Value;

				// Check + reserve BOTH leg names atomically under one lock.
				lock (orderLock)
				{
					SubmittedOrder priorStop, priorTarget;
					var hasStop   = submittedOrders.TryGetValue(stopClientOrderId, out priorStop);
					var hasTarget = submittedOrders.TryGetValue(targetClientOrderId, out priorTarget);
					if (hasStop && hasTarget && priorStop.Completed && priorTarget.Completed)
					{
						Log("place_oco dedup: pair " + stopClientOrderId + "/" + targetClientOrderId + " already submitted; replaying ack");
						SendOcoAck(id, ocoId, priorStop.Contract,
							stopClientOrderId, priorStop.OrderId, priorStop.State,
							targetClientOrderId, priorTarget.OrderId, priorTarget.State,
							priorStop.StopPrice, priorTarget.LimitPrice, true);
						return;
					}
					if (hasStop && hasTarget)
					{
						// Both leg names reserved but not both Completed: this pair is
						// still in flight. Refuse — never fire a second pair.
						Log("place_oco dedup: pair " + stopClientOrderId + "/" + targetClientOrderId + " is in flight; refusing concurrent resubmit");
						SendErrorResponse(id,
							"OCO pair '" + ocoId + "' is currently in flight — do not resubmit; check again shortly",
							"in-flight");
						return;
					}
					if (hasStop || hasTarget)
					{
						// Exactly ONE leg name exists — a genuine orphan (a live pair is
						// always submitted atomically). Server's oco-partial recovers.
						Log("place_oco dedup: leg name collision for " + (hasStop ? stopClientOrderId : targetClientOrderId) + "; refusing");
						SendErrorResponse(id,
							"an order named '" + (hasStop ? stopClientOrderId : targetClientOrderId)
							+ "' already exists without its OCO sibling — do not resubmit; check get_positions",
							"oco-partial");
						return;
					}
					submittedOrders[stopClientOrderId]   = new SubmittedOrder { Completed = false };
					submittedOrders[targetClientOrderId] = new SubmittedOrder { Completed = false };
				}
				reserved = true;

				// Gate — keystone, fail-closed, FULL check (a triggered exit on a flat account opens a position).
				var gate = LoadTradingGate();
				if (gate == null || !gate.enabled)
				{
					SendErrorResponse(id, "AddOn trading gate disabled (trading.config.json missing or enabled=false)", "gate-disabled");
					Log("place_oco BLOCKED (gate disabled) account=" + accountName + " " + actionStr + " " + quantity + " " + symbol);
					return;
				}
				if (gate.allowAccounts == null || !gate.allowAccounts.Contains(accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("place_oco BLOCKED (account not allowed) account=" + accountName);
					return;
				}
				if (quantity > gate.maxQty)
				{
					SendErrorResponse(id, "quantity " + quantity + " exceeds AddOn maxQty " + gate.maxQty, "qty-exceeds-max");
					Log("place_oco BLOCKED (qty>max) qty=" + quantity + " max=" + gate.maxQty + " account=" + accountName);
					return;
				}

				OrderAction action;
				TimeInForce tif;
				if (!TryParseAction(actionStr, out action)) { SendErrorResponse(id, "invalid action: " + actionStr, "invalid-params"); return; }
				if (!TryParseTif(tifStr, out tif))          { SendErrorResponse(id, "invalid tif: "    + tifStr,    "invalid-params"); return; }

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var instrument = RequireTradable(symbol, id, "place_oco");
				if (instrument == null) return;

				stopPrice  = RoundToTick(instrument, stopPrice);
				limitPrice = RoundToTick(instrument, limitPrice);

				// Create BOTH legs before any Submit; a throw leaves nothing
				// submitted (unsubmitted orders carry no NT8 state), finally releases.
				Order stopOrder, targetOrder;
				try
				{
					stopOrder = account.CreateOrder(
						instrument, action, OrderType.StopMarket, OrderEntry.Automated, tif,
						quantity, 0, stopPrice,
						ocoId,               // oco — NT8 links the pair on this id
						stopClientOrderId,   // name — correlation + dedupe key
						Globals.MaxDate, null);
					targetOrder = account.CreateOrder(
						instrument, action, OrderType.Limit, OrderEntry.Automated, tif,
						quantity, limitPrice, 0,
						ocoId,
						targetClientOrderId,
						Globals.MaxDate, null);
				}
				catch (Exception ex) { SendErrorResponse(id, "CreateOrder failed: " + ex.Message, "create-order-failed"); return; }

				// ONE atomic Submit of both legs — never per-leg.
				try { account.Submit(new[] { stopOrder, targetOrder }); }
				catch (Exception ex)
				{
					ambiguous = true;
					SendErrorResponse(id, "Submit failed: " + ex.Message, "submit-failed");
					return;
				}

				// Never auto-remove the reservations past this line.
				committed = true;

				// Guarded field reads, same rationale as HandlePlaceOrder.
				var contract = symbol;
				try { contract = instrument.FullName ?? symbol; } catch { /* transient — keep symbol */ }
				string stopOrderId = null, targetOrderId = null;
				var stopState = "Submitted";
				var targetState = "Submitted";
				try { stopOrderId = stopOrder.OrderId; }              catch { /* not assigned yet */ }
				try { stopState = stopOrder.OrderState.ToString(); }  catch { /* transient */ }
				try { targetOrderId = targetOrder.OrderId; }             catch { /* not assigned yet */ }
				try { targetState = targetOrder.OrderState.ToString(); } catch { /* transient */ }

				lock (orderLock)
				{
					submittedOrders[stopClientOrderId] = new SubmittedOrder
					{
						Contract = contract, OrderId = stopOrderId, State = stopState,
						StopPrice = stopPrice, Completed = true,
					};
					submittedOrders[targetClientOrderId] = new SubmittedOrder
					{
						Contract = contract, OrderId = targetOrderId, State = targetState,
						LimitPrice = limitPrice, Completed = true,
					};
				}

				Log("place_oco SUBMITTED account=" + accountName + " " + actionStr + " " + quantity
					+ " " + contract + " oco=" + ocoId + " stop@" + stopPrice + " target@" + limitPrice);
				SendOcoAck(id, ocoId, contract,
					stopClientOrderId, stopOrderId, stopState,
					targetClientOrderId, targetOrderId, targetState,
					stopPrice, limitPrice, false);
			}
			catch (Exception ex)
			{
				// Unexpected, codeless failure — the TS side treats it as ambiguous.
				SendErrorResponse(id, "place_oco failed: " + ex.Message);
			}
			finally
			{
				if (reserved && !committed && !ambiguous)
				{
					lock (orderLock)
					{
						submittedOrders.Remove(stopClientOrderId);
						submittedOrders.Remove(targetClientOrderId);
					}
				}
			}
		}

		private void SendOcoAck(string id, string ocoId, string contract,
			string stopCoid, string stopOrderId, string stopState,
			string targetCoid, string targetOrderId, string targetState,
			double stopPrice, double limitPrice, bool deduped)
		{
			var stop = new Dictionary<string, object>
			{
				{ "clientOrderId", stopCoid ?? "" },
				{ "state",         stopState ?? "" },
			};
			if (!string.IsNullOrEmpty(stopOrderId)) stop["orderId"] = stopOrderId;
			var target = new Dictionary<string, object>
			{
				{ "clientOrderId", targetCoid ?? "" },
				{ "state",         targetState ?? "" },
			};
			if (!string.IsNullOrEmpty(targetOrderId)) target["orderId"] = targetOrderId;
			var payload = new Dictionary<string, object>
			{
				{ "v",        1 },
				{ "id",       id },
				{ "type",     "oco_ack" },
				{ "ocoId",    ocoId ?? "" },
				{ "contract", contract ?? "" },
				{ "stop",     stop },
				{ "target",   target },
				{ "deduped",  deduped },
			};
			// Effective (tick-rounded) prices; 0 = unknown (old entry), omitted.
			if (stopPrice > 0)  payload["stopPrice"]  = stopPrice;
			if (limitPrice > 0) payload["limitPrice"] = limitPrice;
			SendFireAndForget(Json.Serialize(payload), "oco_ack oco=" + ocoId + " id=" + id);
		}

		private void HandleCancelOrder(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("cancel_order missing id; dropping"); return; }
			try
			{
				var accountName   = GetString(obj, "account");
				var clientOrderId = GetString(obj, "clientOrderId");
				if (string.IsNullOrEmpty(accountName))   { SendErrorResponse(id, "cancel_order missing account",       "invalid-params"); return; }
				if (string.IsNullOrEmpty(clientOrderId)) { SendErrorResponse(id, "cancel_order missing clientOrderId", "invalid-params"); return; }

				var gate = LoadTradingGate();
				if (!RiskReducingAllowed(gate, accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("cancel_order BLOCKED (account not allowed) account=" + accountName);
					return;
				}

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var order = FindWorkingOrderByName(account, clientOrderId);
				if (order == null)
				{
					SendErrorResponse(id, "no order named '" + clientOrderId + "' on account " + accountName, "order-not-found");
					return;
				}
				var terminalState = TerminalStateOf(order);
				if (terminalState != null)
				{
					// Carries the state so the caller learns Filled vs Cancelled.
					SendErrorResponse(id, "order '" + clientOrderId + "' is already in terminal state " + terminalState, "already-terminal");
					return;
				}

				try { account.Cancel(new[] { order }); }
				catch (Exception ex) { SendErrorResponse(id, "Cancel failed: " + ex.Message, "cancel-failed"); return; }

				var postState = "CancelSubmitted";
				try { postState = order.OrderState.ToString(); } catch { /* transient */ }
				string orderId = null;
				try { orderId = order.OrderId; } catch { /* not assigned */ }

				Log("cancel_order DISPATCHED account=" + accountName + " coid=" + clientOrderId + " state=" + postState);
				var payload = new Dictionary<string, object>
				{
					{ "v",             1 },
					{ "id",            id },
					{ "type",          "cancel_ack" },
					{ "clientOrderId", clientOrderId },
					{ "state",         postState },
				};
				if (!string.IsNullOrEmpty(orderId)) payload["orderId"] = orderId;
				SendFireAndForget(Json.Serialize(payload), "cancel_ack coid=" + clientOrderId + " id=" + id);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "cancel_order failed: " + ex.Message);
			}
		}

		// Terminal-state name, or null when still working (or unreadable).
		private static string TerminalStateOf(Order order)
		{
			try
			{
				var st = order.OrderState;
				return Order.IsTerminalState(st) ? st.ToString() : null;
			}
			catch { return null; }
		}

		private void HandleCancelAll(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("cancel_all missing id; dropping"); return; }
			try
			{
				var accountName = GetString(obj, "account");
				var symbol      = GetString(obj, "symbol");
				if (string.IsNullOrEmpty(accountName)) { SendErrorResponse(id, "cancel_all missing account", "invalid-params"); return; }
				if (string.IsNullOrEmpty(symbol))      { SendErrorResponse(id, "cancel_all missing symbol",  "invalid-params"); return; }

				var gate = LoadTradingGate();
				if (!RiskReducingAllowed(gate, accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("cancel_all BLOCKED (account not allowed) account=" + accountName);
					return;
				}

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var instrument = ResolveInstrument(symbol);
				if (instrument == null) { SendErrorResponse(id, "could not resolve instrument for symbol: " + symbol, "instrument-not-found"); return; }

				// Bare symbol: every exposed contract of the master. Explicit name: exact.
				var targets  = IsFullContractName(symbol)
					? new List<Instrument> { instrument }
					: ExposureOfMaster(account, symbol, instrument);
				var contract = DescribeTargets(targets, symbol);
				var names    = new HashSet<string>(StringComparer.Ordinal);
				foreach (var t in targets) { try { names.Add(t.FullName); } catch { } }

				// Best-effort count only; the ack is not a confirmation.
				var working = 0;
				try
				{
					lock (account.Orders)
					{
						foreach (var o in account.Orders)
						{
							if (o == null) continue;
							try
							{
								if (Order.IsTerminalState(o.OrderState)) continue;
								if (o.Instrument != null && names.Contains(o.Instrument.FullName)) working++;
							}
							catch { /* order mid-teardown */ }
						}
					}
				}
				catch { /* count stays 0; still dispatch */ }

				try { foreach (var t in targets) account.CancelAllOrders(t); }
				catch (Exception ex) { SendErrorResponse(id, "CancelAllOrders failed: " + ex.Message, "cancel-all-failed"); return; }

				Log("cancel_all DISPATCHED account=" + accountName + " contract=" + contract + " working=" + working);
				var payload = new Dictionary<string, object>
				{
					{ "v",              1 },
					{ "id",             id },
					{ "type",           "cancel_all_ack" },
					{ "contract",       contract },
					{ "cancelledCount", working },
				};
				SendFireAndForget(Json.Serialize(payload), "cancel_all_ack contract=" + contract + " id=" + id);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "cancel_all failed: " + ex.Message);
			}
		}

		private void HandleFlatten(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("flatten missing id; dropping"); return; }
			try
			{
				var accountName = GetString(obj, "account");
				var symbol      = GetString(obj, "symbol");
				if (string.IsNullOrEmpty(accountName)) { SendErrorResponse(id, "flatten missing account", "invalid-params"); return; }
				if (string.IsNullOrEmpty(symbol))      { SendErrorResponse(id, "flatten missing symbol",  "invalid-params"); return; }

				var gate = LoadTradingGate();
				if (!RiskReducingAllowed(gate, accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("flatten BLOCKED (account not allowed) account=" + accountName);
					return;
				}

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var instrument = ResolveInstrument(symbol);
				if (instrument == null) { SendErrorResponse(id, "could not resolve instrument for symbol: " + symbol, "instrument-not-found"); return; }

				// Bare symbol: every exposed contract of the master. Explicit name: exact.
				var targets  = IsFullContractName(symbol)
					? new List<Instrument> { instrument }
					: ExposureOfMaster(account, symbol, instrument);
				var contract = DescribeTargets(targets, symbol);

				// Cancels every working order AND closes the position at market —
				// including manually placed orders.
				try { account.Flatten(targets.ToArray()); }
				catch (Exception ex) { SendErrorResponse(id, "Flatten failed: " + ex.Message, "flatten-failed"); return; }

				Log("flatten DISPATCHED account=" + accountName + " contract=" + contract);
				var payload = new Dictionary<string, object>
				{
					{ "v",        1 },
					{ "id",       id },
					{ "type",     "flatten_ack" },
					{ "contract", contract },
				};
				SendFireAndForget(Json.Serialize(payload), "flatten_ack contract=" + contract + " id=" + id);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "flatten failed: " + ex.Message);
			}
		}

		private void HandleChangeOrder(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id)) { Log("change_order missing id; dropping"); return; }
			try
			{
				var accountName   = GetString(obj, "account");
				var clientOrderId = GetString(obj, "clientOrderId");
				var qtyN          = GetInt(obj, "quantity");
				var newLimit      = GetDouble(obj, "limitPrice");
				var newStop       = GetDouble(obj, "stopPrice");
				if (string.IsNullOrEmpty(accountName))   { SendErrorResponse(id, "change_order missing account",       "invalid-params"); return; }
				if (string.IsNullOrEmpty(clientOrderId)) { SendErrorResponse(id, "change_order missing clientOrderId", "invalid-params"); return; }
				if (!qtyN.HasValue && !(newLimit > 0) && !(newStop > 0))
				{
					SendErrorResponse(id, "change_order requires at least one of quantity, limitPrice, stopPrice", "invalid-params");
					return;
				}
				if (qtyN.HasValue && qtyN.Value <= 0) { SendErrorResponse(id, "change_order quantity must be a positive integer", "invalid-params"); return; }

				// Gate — FULL check: a raised qty or widened stop adds risk.
				var gate = LoadTradingGate();
				if (gate == null || !gate.enabled)
				{
					SendErrorResponse(id, "AddOn trading gate disabled (trading.config.json missing or enabled=false)", "gate-disabled");
					Log("change_order BLOCKED (gate disabled) account=" + accountName + " coid=" + clientOrderId);
					return;
				}
				if (gate.allowAccounts == null || !gate.allowAccounts.Contains(accountName))
				{
					SendErrorResponse(id, "account '" + accountName + "' is not in the AddOn allow-list", "account-not-allowed");
					Log("change_order BLOCKED (account not allowed) account=" + accountName);
					return;
				}

				var account = FindAccount(accountName);
				if (account == null) { SendErrorResponse(id, "account not found: " + accountName, "account-not-found"); return; }

				var order = FindWorkingOrderByName(account, clientOrderId);
				if (order == null)
				{
					SendErrorResponse(id, "no order named '" + clientOrderId + "' on account " + accountName, "order-not-found");
					return;
				}
				var terminalState = TerminalStateOf(order);
				if (terminalState != null)
				{
					SendErrorResponse(id, "order '" + clientOrderId + "' is already in terminal state " + terminalState, "already-terminal");
					return;
				}

				// Read current values once, guarded — they seed unchanged fields.
				int curQty; double curLimit, curStop; Instrument inst;
				try
				{
					inst     = order.Instrument;
					curQty   = order.Quantity;
					curLimit = order.LimitPrice;
					curStop  = order.StopPrice;
				}
				catch (Exception ex) { SendErrorResponse(id, "could not read working order state: " + ex.Message, "state-read-failed"); return; }

				// Keystone qty check against the EFFECTIVE post-change quantity.
				var effQty = qtyN.HasValue ? qtyN.Value : curQty;
				if (effQty > gate.maxQty)
				{
					SendErrorResponse(id, "quantity " + effQty + " exceeds AddOn maxQty " + gate.maxQty, "qty-exceeds-max");
					Log("change_order BLOCKED (qty>max) qty=" + effQty + " max=" + gate.maxQty + " account=" + accountName);
					return;
				}

				// Stage ALL THREE, unchanged fields to current values (documented
				// safe pattern for Account.Change), new prices tick-rounded.
				var effLimit = newLimit > 0 ? RoundToTick(inst, newLimit) : curLimit;
				var effStop  = newStop  > 0 ? RoundToTick(inst, newStop)  : curStop;
				try
				{
					order.QuantityChanged   = effQty;
					order.LimitPriceChanged = effLimit;
					order.StopPriceChanged  = effStop;
					account.Change(new[] { order });
				}
				catch (Exception ex) { SendErrorResponse(id, "Change failed: " + ex.Message, "change-failed"); return; }

				var postState = "ChangeSubmitted";
				try { postState = order.OrderState.ToString(); } catch { /* transient */ }
				string orderId = null;
				try { orderId = order.OrderId; } catch { /* not assigned */ }

				Log("change_order DISPATCHED account=" + accountName + " coid=" + clientOrderId
					+ " qty=" + effQty + " limit=" + effLimit + " stop=" + effStop + " state=" + postState);
				var payload = new Dictionary<string, object>
				{
					{ "v",             1 },
					{ "id",            id },
					{ "type",          "change_ack" },
					{ "clientOrderId", clientOrderId },
					{ "state",         postState },
					{ "quantity",      effQty },
				};
				if (!string.IsNullOrEmpty(orderId)) payload["orderId"] = orderId;
				// Effective values; 0 = not applicable to this order type.
				if (effLimit > 0) payload["limitPrice"] = effLimit;
				if (effStop  > 0) payload["stopPrice"]  = effStop;
				SendFireAndForget(Json.Serialize(payload), "change_ack coid=" + clientOrderId + " id=" + id);
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "change_order failed: " + ex.Message);
			}
		}
	}
}
