#region Using declarations
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Code;
using NinjaTrader.Core;
using NinjaTrader.NinjaScript;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
	/// <summary>
	/// Watches the Control Center connection light and alerts when it leaves green.
	///
	/// Standalone on purpose: shares no state with McpBridge, so it keeps working
	/// when the MCP server, the /feed socket, or the Python runner are down.
	/// Nothing here touches orders.
	///
	/// "Green" is NOT one flag. NT8 carries two statuses per connection, Status
	/// (orders) and PriceStatus (market data), and watching Status alone misses
	/// the case where orders are fine but data is dead, which is the failure that
	/// runs a strategy on a feed that stopped.
	/// </summary>
	public class FeedWatchdog : AddOnBase
	{
		private const string ConfigFileName = "feed-watchdog.config.json";
		private const int SweepIntervalMs = 60_000;

		// Startup quiet window.
		private const int StartupSettleMs = 15_000;

		// ORANGE is transitional, so make it prove it is not a blip.
		private const int OrangeHoldDownMs = 45_000;

		private const string Green  = "GREEN";
		private const string Orange = "ORANGE";
		private const string Red    = "RED";
		private const string Idle   = "IDLE";   // never connected, not an outage

		private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

		private class WatchdogConfig
		{
			public string webhook;   // Discord webhook URL; omit to log only
			public string[] ignore;  // connection names to skip, e.g. Playback
		}

		private WatchdogConfig cfg;
		private CancellationTokenSource cts;

		// Monotonic, and unlike a "ready" flag set by a background task it cannot
		// get stuck: the settle window closes on its own.
		private Stopwatch uptime;

		private class ConnState
		{
			// Last light EMITTED. null = never spoken about
			public string Reported;
			public long OrangeSince = -1;

			// Sticky: once a half has been Connected, a later Disconnected on it
			// is a real drop rather than "never used".
			public bool OrderEverUp;
			public bool PriceEverUp;
		}

		private readonly Dictionary<string, ConnState> state = new Dictionary<string, ConnState>();

		private readonly object gate = new object();

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Name        = "FeedWatchdog";
				Description = @"Alerts when the NT8 connection light is not green (data feed or order connection).";
			}
			else if (State == State.Configure)
			{
				cfg    = LoadConfig();
				uptime = Stopwatch.StartNew();

				// Process-wide and shared with the rest of NT8: set once, and OR
				// it in so we never take away a protocol something else needs.
				try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; }
				catch (Exception ex) { Log("could not enable TLS 1.2: " + ex.Message); }
				Connection.ConnectionStatusUpdate += OnConnectionStatusUpdate;
				cts = new CancellationTokenSource();
				Task.Run(() => SweepLoopAsync(cts.Token));
				Log("started — " + (cfg != null && !string.IsNullOrEmpty(cfg.webhook)
					? "alerts to Discord + this window"
					: "this window only (no webhook configured)"));
			}
			else if (State == State.Terminated)
			{
				try
				{
					Connection.ConnectionStatusUpdate -= OnConnectionStatusUpdate;
					if (cts != null) cts.Cancel();
				}
				catch (Exception ex) { Log("shutdown error: " + ex.Message); }
			}
		}

		// The payload is ignored on purpose: one code path re-reads every
		// connection, and our own state is the edge detector.
		private void OnConnectionStatusUpdate(object sender, ConnectionStatusEventArgs e)
		{
			SafeCheck("status update");
		}

		private async Task SweepLoopAsync(CancellationToken ct)
		{
			// Past the settle window, never equal to it, or this first pass races
			// the gate in CheckAll and is swallowed.
			try { await Task.Delay(StartupSettleMs + 1_000, ct); }
			catch (OperationCanceledException) { return; }
			SafeCheck("startup");

			while (!ct.IsCancellationRequested)
			{
				try { await Task.Delay(SweepIntervalMs, ct); }
				catch (OperationCanceledException) { return; }
				SafeCheck("sweep");
			}
		}

		// A dead sweep loop is a silent watchdog — worse than no watchdog.
		private void SafeCheck(string trigger)
		{
			try { CheckAll(trigger); }
			catch (Exception ex)
			{
				try { Log("check pass failed: " + ex.Message); } catch { }
			}
		}

		// Non-obvious behavior ("ping" = Discord; everything is logged either way):
		//   healthy launch, or coming up from idle ... baseline, no ping
		//   already dead at launch ................... RED ping, first pass
		//   slow connect, or an orange blip .......... nothing, at any duration
		//   data half dies while orders are fine ..... RED ping, immediately
		//   never-connected half ..................... IDLE, logged once
		//   a half that HAS been up, now Disconnected  RED ping
		private void CheckAll(string trigger)
		{
			// Fails OPEN: no stopwatch means check anyway, never go quiet.
			if (uptime != null && uptime.ElapsedMilliseconds < StartupSettleMs) return;

			// NT8 mutates this collection from its own threads, so copy it under
			// NT8's own lock and let go before doing any work.
			var conns = new List<Connection>();
			try
			{
				var live = Connection.Connections;
				if (live == null) return;
				lock (live) { foreach (var c in live) conns.Add(c); }
			}
			catch (Exception ex) { Log("could not read connections: " + ex.Message); return; }

			foreach (var c in conns)
			{
				if (c == null) continue;

				// One entry mid-teardown must not cost us the rest.
				try
				{
					string name;
					try { name = c.Options != null ? (c.Options.Name ?? "?") : "?"; }
					catch { name = "?"; }

					if (IsIgnored(name)) continue;

					var orderStatus = c.Status;
					var priceStatus = c.PriceStatus;

					var detail = name + " — data:" + priceStatus + " orders:" + orderStatus;

					// Decided under the gate, emitted outside it.
					string baseline = null;
					string alert    = null;

					lock (gate)
					{
						var now = uptime != null ? uptime.ElapsedMilliseconds : 0L;

						ConnState st;
						if (!state.TryGetValue(name, out st)) { st = new ConnState(); state[name] = st; }

						if (orderStatus == ConnectionStatus.Connected) st.OrderEverUp = true;
						if (priceStatus == ConnectionStatus.Connected) st.PriceEverUp = true;

						var light = Light(Classify(orderStatus, st.OrderEverUp),
							Classify(priceStatus, st.PriceEverUp));

						if (light == Orange && st.Reported != Orange)
						{
							if (st.OrangeSince < 0)
							{
								st.OrangeSince = now;
							}
							else if (now - st.OrangeSince >= OrangeHoldDownMs)
							{
								alert = "\U0001F7E0 connection is ORANGE — " + detail
									+ " (held " + ((now - st.OrangeSince) / 1000) + "s, trigger: " + trigger + ")";
								st.OrangeSince = -1;
								st.Reported    = light;
							}
							// else: still inside the hold-down, stay silent
						}
						else
						{
							// Any non-orange reading cancels a pending orange.
							st.OrangeSince = -1;

							var prev = st.Reported;
							if (prev != light)
							{
								st.Reported = light;

								if (light == Idle)
								{
									baseline = "idle, never connected this session — " + detail;
								}
								else if (light == Green)
								{
									// A recovery only if we reported an outage.
									if (prev == Red || prev == Orange)
										alert = "\U0001F7E2 connection back to GREEN — " + detail;
									else
										baseline = "baseline — " + detail;
								}
								else
								{
									// The only branch a RED can reach.
									alert = (light == Red ? "\U0001F534" : "\U0001F7E0")
										+ " connection is " + light + " — " + detail
										+ " (trigger: " + trigger + ")";
								}
							}
						}
					}

					if (baseline != null) Log(baseline);
					if (alert    != null) Alert(alert);
				}
				catch (Exception ex)
				{
					Log("check failed for a connection: " + ex.Message);
				}
			}
		}

		private enum Half { Up, Down, Pending, Idle }

		private static Half Classify(ConnectionStatus s, bool everUp)
		{
			if (s == ConnectionStatus.Connected)     return Half.Up;
			if (s == ConnectionStatus.ConnectionLost) return Half.Down;
			if (s == ConnectionStatus.Disconnected)  return everUp ? Half.Down : Half.Idle;
			return Half.Pending;
		}

		private static string Light(Half order, Half price)
		{
			if (order == Half.Down || price == Half.Down) return Red;
			if (order == Half.Idle && price == Half.Idle) return Idle;

			if ((order == Half.Up || order == Half.Idle)
			 && (price == Half.Up || price == Half.Idle)) return Green;

			return Orange;
		}

		private bool IsIgnored(string name)
		{
			if (cfg == null || cfg.ignore == null) return false;
			foreach (var ig in cfg.ignore)
				if (string.Equals(ig, name, StringComparison.OrdinalIgnoreCase)) return true;
			return false;
		}

		// ---------- output ----------

		private void Alert(string msg)
		{
			Log(msg);
			if (cfg == null || string.IsNullOrEmpty(cfg.webhook)) return;

			// Fire-and-forget: a slow webhook must never stall the NT8 thread.
			var webhook = cfg.webhook;
			Task.Run(() =>
			{
				try
				{
					using (var wc = new WebClient())
					{
						wc.Encoding = Encoding.UTF8;
						wc.Headers[HttpRequestHeader.ContentType] = "application/json";
						wc.UploadString(webhook, "POST",
							Json.Serialize(new Dictionary<string, object> { { "content", msg } }));
					}
				}
				catch (Exception ex) { Log("webhook failed: " + ex.Message); }
			});
		}

		private WatchdogConfig LoadConfig()
		{
			var path = Path.Combine(Globals.UserDataDir, ConfigFileName);
			if (!File.Exists(path))
			{
				Log("no config at " + path
					+ " — logging to this window only. To get Discord alerts create it with "
					+ "{\"webhook\":\"https://discord.com/api/webhooks/...\"}");
				return null;
			}
			try
			{
				var parsed = Json.Deserialize<WatchdogConfig>(File.ReadAllText(path));

				// Otherwise a typo surfaces at the first alert. Warn only — the
				// value is still used, and the output window works regardless.
				if (parsed != null && !string.IsNullOrEmpty(parsed.webhook))
				{
					Uri parsedUrl;
					if (!Uri.TryCreate(parsed.webhook, UriKind.Absolute, out parsedUrl)
						|| (parsedUrl.Scheme != Uri.UriSchemeHttp && parsedUrl.Scheme != Uri.UriSchemeHttps))
						// Never log the whole value — it is a credential.
						Log("WARNING: webhook in " + ConfigFileName + " is not an http(s) URL (starts \""
							+ parsed.webhook.Substring(0, Math.Min(12, parsed.webhook.Length))
							+ "...\") — Discord alerts will fail.");
				}
				return parsed;
			}
			catch (Exception ex) { Log("failed to parse config: " + ex.Message); return null; }
		}

		private static void Log(string msg)
		{
			Output.Process("[FeedWatchdog] " + msg, PrintTo.OutputTab1);
		}
	}
}
