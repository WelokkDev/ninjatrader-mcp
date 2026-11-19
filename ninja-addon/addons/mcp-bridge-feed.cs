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
		private const int ConnectFeedDefaultWaitMs  = 60_000;
		private const int ConnectFeedMinWaitMs      = 5_000;
		private const int ConnectFeedMaxWaitMs      = 180_000;
		private const int ConnectFeedPollMs         = 250;
		// A logon can fail ~150 ms after the light turns green, so green has to hold.
		private const int ConnectFeedSettleMs       = 2_000;
		private const int ConnectFeedNoErrorGraceMs = 5_000;

		private class FeedAttempt
		{
			public string       Name;
			public bool         Found;
			public bool         Ok;
			public bool         AlreadyConnected;
			public bool         WaitedForNt8;
			public string       Status      = "None";
			public string       PriceStatus = "None";
			public string       NtError;
			public string       NativeError;
			public string       Message;
			public long         ElapsedMs;
			public List<string> Configured;
		}

		private class ErrorNote
		{
			public DateTime At; // UTC
			public string   Error;
			public string   NativeError;
		}

		private readonly object connStateLock = new object();
		private readonly Dictionary<string, ErrorNote> lastConnectionError =
			new Dictionary<string, ErrorNote>(StringComparer.OrdinalIgnoreCase);
		private readonly ConcurrentDictionary<string, SemaphoreSlim> connectGates =
			new ConcurrentDictionary<string, SemaphoreSlim>(StringComparer.OrdinalIgnoreCase);

		private void HandleConnectFeed(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("connect_feed missing id; dropping");
				return;
			}
			try
			{
				var name = GetString(obj, "connection");
				if (string.IsNullOrWhiteSpace(name))
				{
					SendErrorResponse(id, "connect_feed missing required field: connection");
					return;
				}
				var waitMs = Math.Max(ConnectFeedMinWaitMs,
					Math.Min(ConnectFeedMaxWaitMs, GetInt(obj, "timeoutMs") ?? ConnectFeedDefaultWaitMs));
				Log("connect_feed " + name + " (waits up to " + (waitMs / 1000) + "s)");

				var r = ConnectFeed(name.Trim(), waitMs);
				var payload = new Dictionary<string, object>
				{
					{ "v",                1 },
					{ "id",               id },
					{ "type",             "connect_feed_response" },
					{ "connection",       r.Name },
					{ "found",            r.Found },
					{ "ok",               r.Ok },
					{ "alreadyConnected", r.AlreadyConnected },
					{ "waitedForNt8",     r.WaitedForNt8 },
					{ "status",           r.Status },
					{ "priceStatus",      r.PriceStatus },
					{ "elapsedMs",        r.ElapsedMs },
					{ "connections",      DescribeConnections() },
				};
				if (r.NtError != null)     payload["ntError"]     = r.NtError;
				if (r.NativeError != null) payload["nativeError"] = r.NativeError;
				if (r.Message != null)     payload["message"]     = r.Message;
				if (!r.Found)              payload["configured"]  = r.Configured;
				SendFireAndForget(Json.Serialize(payload), "connect_feed_response id=" + id + " " + r.Name
					+ (r.Ok ? (r.AlreadyConnected ? " already connected" : " connected") : " FAILED: " + DescribeFailure(r)));
			}
			catch (Exception ex)
			{
				SendErrorResponse(id, "connect_feed failed: " + ex.Message);
			}
		}

		// Callers stay off the UI thread: older NT8 builds hung in Connection.Connect there.
		private FeedAttempt ConnectFeed(string requested, int waitMs)
		{
			var sw = System.Diagnostics.Stopwatch.StartNew();
			var r  = new FeedAttempt { Name = requested };

			List<string> configured;
			var options = FindConnectOptions(requested, out configured);
			r.Configured = configured;
			if (options == null)
			{
				r.Message   = "NT8 has no connection named '" + requested + "'";
				r.ElapsedMs = sw.ElapsedMilliseconds;
				return r;
			}
			r.Found = true;
			r.Name  = options.Name;

			var gate = connectGates.GetOrAdd(r.Name, n => new SemaphoreSlim(1, 1));
			if (!gate.Wait(waitMs))
			{
				r.Message = "another connect of " + r.Name + " was still running after " + (waitMs / 1000) + "s";
				return Finish(r, FindConnection(r.Name), sw, DateTime.UtcNow);
			}
			try
			{
				var since = DateTime.UtcNow;
				var c     = FindConnection(r.Name);
				if (IsGreen(c))
				{
					r.Ok               = true;
					r.AlreadyConnected = true;
					return Finish(r, c, sw, since);
				}

				var  connectCalled     = false;
				long connectReturnedMs = -1;
				long greenSinceMs      = -1;
				while (true)
				{
					c = FindConnection(r.Name);
					var now = sw.ElapsedMilliseconds;
					if (IsGreen(c))
					{
						if (greenSinceMs < 0) greenSinceMs = now;
						if (now - greenSinceMs >= ConnectFeedSettleMs) { r.Ok = true; break; }
					}
					else
					{
						greenSinceMs = -1;
						var down = c == null || c.Status == ConnectionStatus.Disconnected;
						if (down && !connectCalled)
						{
							connectCalled = true;
							var failure = CallConnect(options, (int) Math.Max(1, waitMs - now));
							connectReturnedMs = sw.ElapsedMilliseconds;
							if (failure != null) { r.Message = failure; break; }
							continue;
						}
						if (down)
						{
							if (ErrorSince(r.Name, since) != null)
							{
								r.Message = "NT8 could not connect " + r.Name;
								break;
							}
							if (sw.ElapsedMilliseconds - connectReturnedMs >= ConnectFeedNoErrorGraceMs)
							{
								r.Message = "NT8 left " + r.Name + " disconnected without reporting an error";
								break;
							}
						}
						else if (!connectCalled)
						{
							// Connecting, reconnecting or disconnecting: let NT8 finish first.
							r.WaitedForNt8 = true;
						}
					}
					var limit = greenSinceMs < 0 ? waitMs : waitMs + ConnectFeedSettleMs;
					if (now >= limit)
					{
						r.Message = "not connected after " + (waitMs / 1000) + "s";
						break;
					}
					Thread.Sleep(ConnectFeedPollMs);
				}
				return Finish(r, c, sw, since);
			}
			finally
			{
				gate.Release();
			}
		}

		private static string CallConnect(ConnectOptions options, int waitMs)
		{
			try
			{
				var call = Task.Run(() => Connection.Connect(options));
				if (!call.Wait(waitMs))
					return "Connection.Connect did not return within " + (waitMs / 1000) + "s";
				return null;
			}
			catch (AggregateException ex)
			{
				return "Connection.Connect threw: " + (ex.InnerException ?? ex).Message;
			}
			catch (Exception ex)
			{
				return "Connection.Connect threw: " + ex.Message;
			}
		}

		private FeedAttempt Finish(FeedAttempt r, Connection c, System.Diagnostics.Stopwatch sw, DateTime since)
		{
			if (c != null)
			{
				r.Status      = c.Status.ToString();
				r.PriceStatus = c.PriceStatus.ToString();
			}
			if (!r.Ok)
			{
				var note = ErrorSince(r.Name, since);
				if (note != null)
				{
					r.NtError     = note.Error;
					r.NativeError = note.NativeError;
				}
			}
			r.ElapsedMs = sw.ElapsedMilliseconds;
			return r;
		}

		private ErrorNote ErrorSince(string name, DateTime sinceUtc)
		{
			lock (connStateLock)
			{
				ErrorNote note;
				return lastConnectionError.TryGetValue(name, out note) && note.At >= sinceUtc ? note : null;
			}
		}

		private static ConnectOptions FindConnectOptions(string name, out List<string> configured)
		{
			configured = new List<string>();
			ConnectOptions match = null;
			var all = Globals.ConnectOptions;
			if (all == null) return null;
			lock (all)
			{
				foreach (var o in all)
				{
					if (o == null || string.IsNullOrEmpty(o.Name)) continue;
					configured.Add(o.Name);
					if (match == null && string.Equals(o.Name, name, StringComparison.OrdinalIgnoreCase)) match = o;
				}
			}
			return match;
		}

		private static Connection FindConnection(string name)
		{
			var live = Connection.Connections;
			if (live == null) return null;
			lock (live)
			{
				foreach (var c in live)
					if (string.Equals(ConnectionName(c), name, StringComparison.OrdinalIgnoreCase)) return c;
			}
			return null;
		}

		private static string ConnectionName(Connection c)
		{
			try { return c != null && c.Options != null ? c.Options.Name : null; }
			catch { return null; }
		}

		// Both halves: orders (Status) and market data (PriceStatus).
		private static bool IsGreen(Connection c)
		{
			return c != null
				&& c.Status      == ConnectionStatus.Connected
				&& c.PriceStatus == ConnectionStatus.Connected;
		}

		private static List<object> DescribeConnections()
		{
			var list = new List<object>();
			var live = Connection.Connections;
			if (live == null) return list;
			lock (live)
			{
				foreach (var c in live)
				{
					var name = ConnectionName(c);
					if (name == null) continue;
					list.Add(new Dictionary<string, object>
					{
						{ "name",        name },
						{ "status",      c.Status.ToString() },
						{ "priceStatus", c.PriceStatus.ToString() },
					});
				}
			}
			return list;
		}

		private void NoteConnectionError(ConnectionStatusEventArgs e)
		{
			if (e.Error == ErrorCode.NoError) return;
			var name = ConnectionName(e.Connection);
			if (name == null) return;
			lock (connStateLock)
				lastConnectionError[name] = new ErrorNote { At = DateTime.UtcNow, Error = e.Error.ToString(), NativeError = e.NativeError };
		}

		private static string DescribeFailure(FeedAttempt r)
		{
			var s = r.Message ?? "failed";
			if (r.NtError != null)
				s += " — NT8 error " + r.NtError + (string.IsNullOrEmpty(r.NativeError) ? "" : " \"" + r.NativeError + "\"");
			return s;
		}
	}
}
