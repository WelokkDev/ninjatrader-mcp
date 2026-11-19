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
		// request_open_charts — enumerates every open chart window/tab via
		// undocumented-but-staff-endorsed API (Globals.AllWindows, Chart,
		// MainTabControl, ChartTab — forum 1055530/100732); may change between NT8
		// builds, so every hop is null-guarded and failures degrade, never throw.

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

		// request_drawings — read NT8 drawing objects (including hand-drawn ones)
		// off every open chart. Works against the base DrawingTool type only
		// (Tag/IsUserDrawn/Anchors), so it never compiles against concrete tools
		// like RiskReward: the concrete type is reported as GetType().Name and
		// Risk/Reward geometry is parsed from its ordered anchors [entry, stop, target].

		private const int DrawingsBudgetMs = 3_000;

		private void HandleRequestDrawings(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_drawings missing id; dropping");
				return;
			}
			var symbolFilter   = GetString(obj, "symbol");
			var toolTypeFilter = GetString(obj, "toolType");
			var userDrawnOnly  = GetBool(obj, "userDrawnOnly") ?? false;
			Task.Run(async () =>
			{
				try { await BuildAndSendDrawingsAsync(id, symbolFilter, toolTypeFilter, userDrawnOnly); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "request_drawings failed: " + ex.Message);
				}
			});
		}

		private async Task BuildAndSendDrawingsAsync(string id, string symbolFilter, string toolTypeFilter, bool userDrawnOnly)
		{
			// Snapshot first: other threads open/close windows while we walk.
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
				perWindow.Add(ReadChartDrawingsAsync(chart, symbolFilter, toolTypeFilter, userDrawnOnly));

			await Task.WhenAny(Task.WhenAll(perWindow), Task.Delay(DrawingsBudgetMs));

			var drawings = new List<object>();
			var skipped  = 0;
			foreach (var t in perWindow)
			{
				if (t.Status == TaskStatus.RanToCompletion && t.Result != null)
					foreach (var d in t.Result) drawings.Add(d);
				else
					skipped++;
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",              1 },
				{ "id",             id },
				{ "type",           "drawings_response" },
				{ "drawings",       drawings },
				{ "skippedWindows", skipped },
			};
			SendFireAndForget(Json.Serialize(payload),
				"drawings_response id=" + id + " drawings=" + drawings.Count
				+ (skipped > 0 ? " skippedWindows=" + skipped : ""));
		}

		// Read on the window's own dispatcher (InvokeAsync, never Invoke — deadlock
		// risk); failures resolve to an empty list, never throwing across the boundary.
		private static Task<List<Dictionary<string, object>>> ReadChartDrawingsAsync(
			NinjaTrader.Gui.Chart.Chart chart, string symbolFilter, string toolTypeFilter, bool userDrawnOnly)
		{
			var tcs = new TaskCompletionSource<List<Dictionary<string, object>>>();
			try
			{
				chart.Dispatcher.InvokeAsync(() =>
				{
					var outList = new List<Dictionary<string, object>>();
					try
					{
						string title = null;
						try { title = chart.Title; } catch { /* label only */ }

						var tabControl = chart.MainTabControl;
						if (tabControl != null)
						{
							foreach (var item in tabControl.Items)
							{
								try
								{
									var tabItem  = item as System.Windows.Controls.TabItem;
									var chartTab = tabItem != null
										? tabItem.Content as NinjaTrader.Gui.Chart.ChartTab
										: null;
									if (chartTab == null) continue;
									ReadTabDrawings(title, chartTab, symbolFilter, toolTypeFilter, userDrawnOnly, outList);
								}
								catch (Exception ex) { Log("drawings tab read failed: " + ex.Message); }
							}
						}
					}
					catch (Exception ex) { Log("drawings window read failed: " + ex.Message); }
					tcs.TrySetResult(outList);
				});
			}
			catch (Exception ex)
			{
				// Window mid-close: its dispatcher is already shutting down.
				Log("drawings dispatch failed: " + ex.Message);
				tcs.TrySetResult(new List<Dictionary<string, object>>());
			}
			return tcs.Task;
		}

		// Read the drawing objects on one chart tab (on the window dispatcher).
		// Symbol/timeframe come the same way as DescribeChartTab.
		private static void ReadTabDrawings(
			string windowTitle,
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			string symbolFilter,
			string toolTypeFilter,
			bool userDrawnOnly,
			List<Dictionary<string, object>> outList)
		{
			var cc = chartTab.ChartControl;
			if (cc == null) return;

			string symbol    = "";
			string timeframe = "";
			Bars bars = null;
			try
			{
				var chartBars = cc.PrimaryBars;
				if (chartBars == null && cc.BarsArray != null && cc.BarsArray.Count > 0)
					chartBars = cc.BarsArray[0];
				if (chartBars != null) bars = chartBars.Bars;
			}
			catch { /* chart mid-load */ }
			try
			{
				Instrument inst = bars != null ? bars.Instrument : null;
				if (inst == null) inst = chartTab.Instrument;
				if (inst != null && inst.MasterInstrument != null) symbol = inst.MasterInstrument.Name;
			}
			catch { /* tab mid-load */ }
			try { if (bars != null) timeframe = CompactTimeframe(bars.BarsPeriod); }
			catch { /* bars mid-teardown */ }

			if (!string.IsNullOrEmpty(symbolFilter)
				&& !string.Equals(symbol, symbolFilter, StringComparison.OrdinalIgnoreCase))
				return;

			// Drawings live on panels, so walk ChartPanel.ChartObjects (NT8's own
			// idiom). Snapshot first (reentrancy); the per-tag dedup collapses overlap.
			var snapshot = new List<object>();
			try
			{
				var panels = cc.ChartPanels;
				if (panels != null)
					foreach (var panel in panels)
						if (panel != null && panel.ChartObjects != null)
							foreach (var co in panel.ChartObjects) snapshot.Add(co);
			}
			catch (Exception ex) { Log("drawings ChartObjects snapshot failed: " + ex.Message); return; }

			var seenTags = new HashSet<string>();
			foreach (var co in snapshot)
			{
				var dt = co as NinjaTrader.NinjaScript.DrawingTools.DrawingTool;
				if (dt == null) continue;
				try
				{
					if (userDrawnOnly && !dt.IsUserDrawn) continue;

					var toolType = dt.GetType().Name;
					if (!string.IsNullOrEmpty(toolTypeFilter)
						&& !string.Equals(toolType, toolTypeFilter, StringComparison.OrdinalIgnoreCase))
						continue;

					var tag = dt.Tag ?? "";
					if (!string.IsNullOrEmpty(tag) && !seenTags.Add(tag)) continue;

					var anchors = new List<object>();
					var prices  = new List<double>();
					try
					{
						foreach (var a in dt.Anchors)
						{
							if (a == null) continue;
							var ad = new Dictionary<string, object> { { "price", a.Price } };
							try { ad["ts"] = ExchangeTimeToUnixSeconds(a.Time); } catch { /* unconvertible */ }
							anchors.Add(ad);
							prices.Add(a.Price);
						}
					}
					catch (Exception ex) { Log("drawings anchor read failed: " + ex.Message); }

					var entry = new Dictionary<string, object>
					{
						{ "window",      string.IsNullOrEmpty(windowTitle) ? "Chart" : windowTitle },
						{ "symbol",      symbol },
						{ "timeframe",   timeframe },
						{ "tag",         tag },
						{ "toolType",    toolType },
						{ "isUserDrawn", dt.IsUserDrawn },
						{ "isVisible",   dt.IsVisible },
						{ "anchors",     anchors },
					};

					// Best-effort text content (Text tool / labelled tools).
					try
					{
						var textProp = dt.GetType().GetProperty("Text") ?? dt.GetType().GetProperty("DisplayText");
						if (textProp != null && textProp.PropertyType == typeof(string))
						{
							var tv = textProp.GetValue(dt) as string;
							if (!string.IsNullOrEmpty(tv)) entry["text"] = tv;
						}
					}
					catch { /* no text property */ }

					// Risk/Reward geometry from the tool's ordered anchors
					// [entry, stop (RiskAnchor), target (RewardAnchor)].
					if (string.Equals(toolType, "RiskReward", StringComparison.Ordinal) && prices.Count >= 3)
					{
						double e = prices[0], stop = prices[1], target = prices[2];
						double riskPts   = Math.Abs(e - stop);
						double rewardPts = Math.Abs(target - e);
						string dir = target > e ? "long" : (target < e ? "short" : "flat");
						var rr = new Dictionary<string, object>
						{
							{ "entry",        e },
							{ "stop",         stop },
							{ "target",       target },
							{ "direction",    dir },
							{ "riskPoints",   riskPts },
							{ "rewardPoints", rewardPts },
						};
						if (riskPts > 0) rr["computedRatio"] = rewardPts / riskPts;
						try
						{
							var ratioProp = dt.GetType().GetProperty("Ratio");
							if (ratioProp != null && ratioProp.PropertyType == typeof(double))
								rr["ratio"] = (double) ratioProp.GetValue(dt);
						}
						catch { /* no Ratio property */ }
						entry["riskReward"] = rr;
					}

					outList.Add(entry);
				}
				catch (Exception ex) { Log("drawings object read failed: " + ex.Message); }
			}
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

		// navigate_chart — programmatic Go To. Must scroll via the private
		// ChartControl.ScrollToTime (moves the DURABLE anchor so the view survives
		// the next live-bar re-render); the old LastSlotPainted path was a
		// paint-time output NT re-derived, causing intermittent snap-back.

		private const int NavigateChartBudgetMs = 3_000;

		// Resolved once. (DateTime, bool) instance overload ships in
		// NinjaTrader.Gui.dll but is undocumented; null if this build lacks it
		// (handled per-call). Second arg = align the given time to the right edge.
		private static readonly System.Reflection.MethodInfo ScrollToTimeMethod =
			typeof(NinjaTrader.Gui.Chart.ChartControl).GetMethod(
				"ScrollToTime",
				System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic,
				null,
				new Type[] { typeof(DateTime), typeof(bool) },
				null);

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

					// Scroll via private ScrollToTime for BOTH spacing types: it
					// moves the durable anchor so the view holds across the next live
					// bar (LastSlotPainted was a paint-time output that snapped back).
					if (ScrollToTimeMethod == null)
					{
						result["error"] = "ScrollToTime not found in this NT8 build";
						return result;
					}
					ScrollToTimeMethod.Invoke(cc, new object[] { effective, alignRight });
					result["method"] = "scrollToTime";
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

		// request_chart_indicators / request_indicator_values — read-only
		// introspection of the indicators on open charts. Split by call frequency:
		// discovery reflects over every indicator (rare); the value read locates ONE
		// and serves a range of its plot series (frequent, lean). Adding or removing
		// indicators is deliberately out of scope.
		//
		// Reads happen on the window's own Dispatcher; on x64 an aligned double read
		// cannot tear, so the worst cross-thread outcome is a one-tick-stale value.

		private const int ChartIndicatorsBudgetMs = 4_000;
		private const int IndicatorValuesBudgetMs = 4_000;

		// Per-plot payload guard; mirrored by INDICATOR_VALUES_MAX_POINTS in the server.
		private const int IndicatorValuesMaxPoints = 5_000;

		// Runs ON the window's dispatcher; appends zero or more entries for one tab.
		private delegate void ChartTabReader(
			string windowTitle,
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			bool isActive,
			List<Dictionary<string, object>> outList);

		private class ChartWalkResult
		{
			public List<Dictionary<string, object>> Entries = new List<Dictionary<string, object>>();
			public int                              Skipped;
		}

		// Built once off the WS thread, then read (never mutated) on every dispatcher.
		private class IndicatorSelector
		{
			public string SymbolFilter;
			public string TimeframeFilter;
			public int?   IndicatorId;
			public string MatchName;
			public IDictionary<string, object> MatchParams;
		}

		private class IndicatorValueQuery : IndicatorSelector
		{
			public long?  FromTs;
			public long?  ToTs;
			public int?   LastBars;
		}

		// Shared window walk for both indicator reads. Deliberately parallel to
		// BuildAndSendOpenChartsAsync rather than a refactor of it: open_charts is a
		// working path and its response must stay byte-identical.
		private static async Task<ChartWalkResult> WalkChartTabsAsync(
			int budgetMs, string logTag, ChartTabReader readTab)
		{
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
				throw new InvalidOperationException("window enumeration failed: " + ex.Message, ex);
			}

			var perWindow = new List<Task<List<Dictionary<string, object>>>>();
			foreach (var chart in chartWindows)
				perWindow.Add(ReadChartWindowTabsAsync(chart, logTag, readTab));

			await Task.WhenAny(Task.WhenAll(perWindow), Task.Delay(budgetMs));

			var result = new ChartWalkResult();
			foreach (var t in perWindow)
			{
				if (t.Status == TaskStatus.RanToCompletion && t.Result != null)
					foreach (var e in t.Result) result.Entries.Add(e);
				else
					result.Skipped++;
			}
			return result;
		}

		// Dispatcher discipline of ReadChartWindowAsync: InvokeAsync only; failures
		// resolve to an empty list and never throw across the boundary.
		private static Task<List<Dictionary<string, object>>> ReadChartWindowTabsAsync(
			NinjaTrader.Gui.Chart.Chart chart, string logTag, ChartTabReader readTab)
		{
			var tcs = new TaskCompletionSource<List<Dictionary<string, object>>>();
			try
			{
				chart.Dispatcher.InvokeAsync(() =>
				{
					var outList = new List<Dictionary<string, object>>();
					try
					{
						string title = null;
						try { title = chart.Title; } catch { /* label only */ }

						var tabControl = chart.MainTabControl;
						var selected   = tabControl != null ? tabControl.SelectedItem : null;
						foreach (var entry in ChartTabsOf(chart))
						{
							try { readTab(title, entry.Value, object.ReferenceEquals(entry.Key, selected), outList); }
							catch (Exception ex) { Log(logTag + " tab read failed: " + ex.Message); }
						}
					}
					catch (Exception ex) { Log(logTag + " window read failed: " + ex.Message); }
					tcs.TrySetResult(outList);
				});
			}
			catch (Exception ex)
			{
				// Window mid-close: its dispatcher is already shutting down.
				Log(logTag + " dispatch failed: " + ex.Message);
				tcs.TrySetResult(new List<Dictionary<string, object>>());
			}
			return tcs.Task;
		}

		// Empty filter matches everything — the list_open_charts targeting vocabulary.
		private static bool MatchesChartFilter(
			string symbol, string timeframe, string symbolFilter, string timeframeFilter)
		{
			if (!string.IsNullOrEmpty(symbolFilter)
				&& !string.Equals(symbol, symbolFilter, StringComparison.OrdinalIgnoreCase))
				return false;
			if (!string.IsNullOrEmpty(timeframeFilter)
				&& !string.Equals(timeframe, timeframeFilter, StringComparison.OrdinalIgnoreCase))
				return false;
			return true;
		}

		// Any NT8 hop can throw mid-load/mid-teardown; degrade to the fallback rather
		// than lose the whole indicator.
		private static T TryGet<T>(Func<T> read, T fallback)
		{
			try { return read(); } catch { return fallback; }
		}

		// Snapshot before reflecting: the reflection below is far too slow to hold an
		// enumerator through. No lock — Indicators is mutated on this same dispatcher,
		// so a lock buys nothing while risking an inversion against a background
		// thread waiting on the dispatcher we hold. Our own renderer is skipped.
		private static List<NinjaTrader.Gui.NinjaScript.IndicatorRenderBase> SnapshotIndicators(
			NinjaTrader.Gui.Chart.ChartControl cc)
		{
			var list = new List<NinjaTrader.Gui.NinjaScript.IndicatorRenderBase>();
			try
			{
				if (cc.Indicators != null)
					foreach (var ind in cc.Indicators)
						if (ind != null && ind.GetType().Name != "McpBridgeRenderer")
							list.Add(ind);
			}
			catch (Exception ex) { Log("indicator snapshot failed: " + ex.Message); }
			return list;
		}

		private void HandleRequestChartIndicators(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_chart_indicators missing id; dropping");
				return;
			}
			var symbolFilter    = GetString(obj, "symbol");
			var timeframeFilter = GetString(obj, "timeframe");
			Task.Run(async () =>
			{
				try { await BuildAndSendChartIndicatorsAsync(id, symbolFilter, timeframeFilter); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "request_chart_indicators failed: " + ex.Message);
				}
			});
		}

		private async Task BuildAndSendChartIndicatorsAsync(
			string id, string symbolFilter, string timeframeFilter)
		{
			var walk = await WalkChartTabsAsync(ChartIndicatorsBudgetMs, "chart_indicators",
				(title, tab, isActive, outList) =>
					ReadTabIndicators(title, tab, isActive, symbolFilter, timeframeFilter, outList));

			var charts = new List<object>();
			foreach (var e in walk.Entries) charts.Add(e);

			var payload = new Dictionary<string, object>
			{
				{ "v",              1 },
				{ "id",             id },
				{ "type",           "chart_indicators_response" },
				{ "charts",         charts },
				{ "skippedWindows", walk.Skipped },
			};
			SendFireAndForget(Json.Serialize(payload),
				"chart_indicators_response id=" + id + " charts=" + charts.Count
				+ (walk.Skipped > 0 ? " skippedWindows=" + walk.Skipped : ""));
		}

		// Dispatcher-thread only. Reuses DescribeChartTab so targeting matches
		// list_open_charts exactly.
		private static void ReadTabIndicators(
			string windowTitle,
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			bool isActive,
			string symbolFilter,
			string timeframeFilter,
			List<Dictionary<string, object>> outList)
		{
			var desc      = DescribeChartTab(windowTitle, chartTab, isActive);
			var symbol    = (desc["symbol"] as string) ?? "";
			var timeframe = (desc["timeframe"] as string) ?? "";
			if (!MatchesChartFilter(symbol, timeframe, symbolFilter, timeframeFilter)) return;

			var cc = chartTab.ChartControl;
			if (cc == null) return;

			var indicators = new List<object>();
			foreach (var ind in SnapshotIndicators(cc))
			{
				try { indicators.Add(DescribeIndicator(ind)); }
				catch (Exception ex) { Log("indicator describe failed: " + ex.Message); }
			}

			outList.Add(new Dictionary<string, object>
			{
				{ "window",     desc["window"] },
				{ "symbol",     symbol },
				{ "instrument", desc["instrument"] },
				{ "timeframe",  timeframe },
				{ "isActive",   isActive },
				{ "indicators", indicators },
			});
		}

		private static Dictionary<string, object> DescribeIndicator(
			NinjaTrader.Gui.NinjaScript.IndicatorRenderBase ind)
		{
			var t = ind.GetType();
			var typeName = t.FullName ?? t.Name;

			// How far back this INSTANCE retains values — not how much the chart loaded.
			string readableDepth;
			try
			{
				readableDepth = ind.ForcePlotsMaximumBarsLookBackInfinite
					? "Infinite"
					: ind.MaximumBarsLookBack.ToString();
			}
			catch { readableDepth = "unknown"; }

			return new Dictionary<string, object>
			{
				{ "id",            TryGet(() => ind.IndicatorId, -1) },
				{ "name",          typeName },
				{ "displayName",   TryGet(() => ind.DisplayName, (string) null) ?? typeName },
				{ "panel",         TryGet(() => ind.Panel, -1) },
				{ "isOverlay",     TryGet(() => ind.IsOverlay, false) },
				{ "displacement",  TryGet(() => ind.Displacement, 0) },
				{ "readableDepth", readableDepth },
				{ "params",        ReadIndicatorParams(ind) },
				{ "plots",         ReadIndicatorPlotStyles(ind) },
			};
		}

		// [Display] ∪ [NinjaScriptProperty] is the right ATTRIBUTE filter — a quarter
		// of built-in params carry [Display] only (e.g. PriorDayOHLC.Show*) — but on
		// its own it also admits the ten properties EVERY indicator inherits
		// (Calculate, Panel, Displacement, IsVisible, Name, …), burying the one or two
		// that identify it. So anything declared on a base type below is dropped;
		// Displacement is promoted to a first-class field instead.
		private static readonly string[] NinjaScriptBaseTypeNames = new string[]
		{
			"NinjaTrader.NinjaScript.NinjaScript",
			"NinjaTrader.NinjaScript.NinjaScriptBase",
			"NinjaTrader.NinjaScript.IndicatorBase",
			"NinjaTrader.Gui.NinjaScript.IndicatorRenderBase",
			"NinjaTrader.NinjaScript.Indicators.Indicator",
		};

		private static bool IsNinjaScriptBaseDeclared(System.Reflection.PropertyInfo p)
		{
			var dt = p.DeclaringType;
			if (dt == null) return true;
			var n = dt.FullName ?? "";
			for (int i = 0; i < NinjaScriptBaseTypeNames.Length; i++)
				if (n == NinjaScriptBaseTypeNames[i]) return true;
			return false;
		}

		// Only types that land cleanly in the wire's string|number|boolean union;
		// anything else (Brush, DateTime, Instrument, …) is dropped rather than risk a
		// payload the server's schema rejects wholesale.
		private static bool IsWireScalar(Type pt)
		{
			if (pt.IsEnum) return true;
			return pt == typeof(bool)  || pt == typeof(string) || pt == typeof(char)
				|| pt == typeof(byte)  || pt == typeof(sbyte)
				|| pt == typeof(short) || pt == typeof(ushort)
				|| pt == typeof(int)   || pt == typeof(uint)
				|| pt == typeof(long)  || pt == typeof(ulong)
				|| pt == typeof(float) || pt == typeof(double) || pt == typeof(decimal);
		}

		private static bool IsIndicatorParam(System.Reflection.PropertyInfo p)
		{
			if (!p.CanRead || p.GetIndexParameters().Length > 0) return false;
			if (IsNinjaScriptBaseDeclared(p)) return false;

			bool hasDisplay = p.GetCustomAttributes(
				typeof(System.ComponentModel.DataAnnotations.DisplayAttribute), false).Length > 0;
			bool isNsp = p.GetCustomAttributes(
				typeof(NinjaTrader.NinjaScript.NinjaScriptPropertyAttribute), false).Length > 0;
			if (!hasDisplay && !isNsp) return false;

			var pt = p.PropertyType;
			// A plot output is a value, not configuration — tool 2 serves those.
			if (typeof(NinjaTrader.NinjaScript.ISeries<double>).IsAssignableFrom(pt)) return false;
			return IsWireScalar(pt);
		}

		private static List<object> ReadIndicatorParams(object ind)
		{
			var prms = new List<object>();
			var t = ind.GetType();
			System.Reflection.PropertyInfo[] props;
			try
			{
				props = t.GetProperties(System.Reflection.BindingFlags.Public
					| System.Reflection.BindingFlags.Instance);
			}
			catch (Exception ex) { Log("indicator param scan failed: " + ex.Message); return prms; }

			foreach (var p in props)
			{
				try
				{
					if (!IsIndicatorParam(p)) continue;

					// Non-generic form: no `using System.Reflection` here, so the
					// GetCustomAttribute<T>() extension method isn't in scope.
					var dispAttrs = p.GetCustomAttributes(
						typeof(System.ComponentModel.DataAnnotations.DisplayAttribute), false);
					var disp = dispAttrs.Length > 0
						? (System.ComponentModel.DataAnnotations.DisplayAttribute) dispAttrs[0]
						: null;

					var pt = p.PropertyType;
					object raw = p.GetValue(ind, null);
					object val;
					if (raw == null)    val = "";
					else if (pt.IsEnum) val = raw.ToString();
					else                val = raw;

					// JavaScriptSerializer emits bare NaN/Infinity — invalid JSON, which
					// would make the server drop the whole response.
					if (val is double && !IsFinite((double) val)) continue;
					if (val is float  && !IsFinite((double)(float) val)) continue;

					// GetName(), never .Name: built-ins set ResourceType, so .Name is the
					// resource KEY ("ShowClose"), GetName() the label ("Show close").
					string label = p.Name;
					if (disp != null)
					{
						try
						{
							var localized = disp.GetName();
							if (!string.IsNullOrEmpty(localized)) label = localized;
						}
						catch { /* unresolvable resource: fall back to the property name */ }
					}

					prms.Add(new Dictionary<string, object>
					{
						{ "name",  p.Name },
						{ "label", label },
						{ "value", val },
					});
				}
				catch { /* one unreadable property never costs the rest */ }
			}
			return prms;
		}

		private static bool IsFinite(double v)
		{
			return !double.IsNaN(v) && !double.IsInfinity(v);
		}

		// Styling only; values come from request_indicator_values.
		private static List<object> ReadIndicatorPlotStyles(
			NinjaTrader.Gui.NinjaScript.IndicatorRenderBase ind)
		{
			var plots = new List<object>();
			var defs  = TryGet(() => ind.Plots, (NinjaTrader.Gui.Plot[]) null);
			if (defs == null) return plots;

			for (int i = 0; i < defs.Length; i++)
			{
				var pd = defs[i];
				if (pd == null) continue;
				var entry = new Dictionary<string, object>();
				var name  = TryGet(() => pd.Name, (string) null);
				entry["name"] = string.IsNullOrEmpty(name) ? ("Plot" + i) : name;

				// Touching the Brush is safe here: we are on the chart's own dispatcher.
				object color = null;
				try
				{
					var scb = pd.Brush as System.Windows.Media.SolidColorBrush;
					if (scb != null) color = scb.Color.ToString(); // "#FFFFA500"
					else             color = TryGet(() => pd.BrushSerialize, (string) null); // gradient: XAML
				}
				catch { /* brush mid-teardown */ }
				entry["color"] = color;

				try { entry["style"] = pd.PlotStyle.ToString(); } catch { /* styling is optional */ }
				plots.Add(entry);
			}
			return plots;
		}

		private void HandleRequestIndicatorValues(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_indicator_values missing id; dropping");
				return;
			}
			Task.Run(async () =>
			{
				try { await BuildAndSendIndicatorValuesAsync(id, obj); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "request_indicator_values failed: " + ex.Message);
				}
			});
		}

		private async Task BuildAndSendIndicatorValuesAsync(string id, IDictionary<string, object> obj)
		{
			var q = new IndicatorValueQuery
			{
				FromTs   = GetLong(obj, "from"),
				ToTs     = GetLong(obj, "to"),
				LastBars = GetInt(obj, "bars"),
			};
			var selectorError = TryParseIndicatorSelector(obj, q, "request_indicator_values");
			if (selectorError != null)
			{
				SendErrorResponse(id, selectorError);
				return;
			}
			var symbol = q.SymbolFilter;
			// No range at all means "the current value".
			if (!q.LastBars.HasValue && !q.FromTs.HasValue && !q.ToTs.HasValue) q.LastBars = 1;

			var walk = await WalkChartTabsAsync(IndicatorValuesBudgetMs, "indicator_values",
				(title, tab, isActive, outList) => ReadTabIndicatorValues(title, tab, isActive, q, outList));

			// First tab that actually held the indicator wins; the rest only record
			// that the symbol matched, which is what found:false has to explain.
			Dictionary<string, object> hit = null;
			string reason = null;
			foreach (var e in walk.Entries)
			{
				object f;
				if (e.TryGetValue("found", out f) && f is bool && (bool) f) { hit = e; break; }
				object r;
				if (reason == null && e.TryGetValue("reason", out r) && r is string) reason = (string) r;
			}

			var payload = new Dictionary<string, object>
			{
				{ "v",    1 },
				{ "id",   id },
				{ "type", "indicator_values_response" },
			};
			if (hit != null)
			{
				// No per-tab key collides with the envelope — that is why the handle is
				// `indicatorId` and not `id` — so a straight copy is safe.
				foreach (var kv in hit) payload[kv.Key] = kv.Value;
			}
			else
			{
				payload["found"]  = false;
				payload["symbol"] = symbol;
				if (!string.IsNullOrEmpty(q.TimeframeFilter)) payload["timeframe"] = q.TimeframeFilter;
				if (reason == null) reason = NoMatchReason(walk, q);
				if (walk.Skipped > 0)
					reason += " (" + walk.Skipped + " chart window(s) missed the read budget)";
				payload["reason"] = reason;
			}
			if (!payload.ContainsKey("plots")) payload["plots"] = new List<object>();

			SendFireAndForget(Json.Serialize(payload),
				"indicator_values_response id=" + id + " found=" + (hit != null)
				+ (hit != null ? " indicator=" + hit["indicatorId"] : ""));
		}

		// Dispatcher-thread only. One entry per MATCHING tab: found=true with values,
		// or found=false so the caller learns the chart was there but the indicator
		// was not.
		private static void ReadTabIndicatorValues(
			string windowTitle,
			NinjaTrader.Gui.Chart.ChartTab chartTab,
			bool isActive,
			IndicatorValueQuery q,
			List<Dictionary<string, object>> outList)
		{
			var desc      = DescribeChartTab(windowTitle, chartTab, isActive);
			var symbol    = (desc["symbol"] as string) ?? "";
			var timeframe = (desc["timeframe"] as string) ?? "";
			if (!MatchesChartFilter(symbol, timeframe, q.SymbolFilter, q.TimeframeFilter)) return;

			var cc = chartTab.ChartControl;
			if (cc == null) return;

			var entry = new Dictionary<string, object>
			{
				{ "found",     false },
				{ "window",    desc["window"] },
				{ "symbol",    symbol },
				{ "timeframe", timeframe },
			};

			NinjaTrader.Gui.NinjaScript.IndicatorRenderBase target = null;
			int matchCount = 0;
			foreach (var ind in SnapshotIndicators(cc))
			{
				if (!IndicatorMatches(ind, q)) continue;
				matchCount++;
				if (target == null) target = ind;
			}
			entry["matchCount"] = matchCount;
			if (target == null) { outList.Add(entry); return; }

			// Values index against the indicator's OWN primary series; the chart's is
			// only a fallback for one not yet assigned.
			Bars bars = TryGet(() => target.Bars, (Bars) null);
			if (bars == null)
			{
				try
				{
					var chartBars = cc.PrimaryBars;
					if (chartBars == null && cc.BarsArray != null && cc.BarsArray.Count > 0)
						chartBars = cc.BarsArray[0];
					if (chartBars != null) bars = chartBars.Bars;
				}
				catch { /* chart mid-load */ }
			}
			int barCount = bars == null ? 0 : TryGet(() => bars.Count, 0);
			if (bars == null || barCount == 0)
			{
				entry["reason"] = "chart has no loaded bars";
				outList.Add(entry);
				return;
			}

			entry["found"]        = true;
			entry["indicatorId"]  = TryGet(() => target.IndicatorId, -1);
			entry["displayName"]  = TryGet(() => target.DisplayName, (string) null) ?? target.GetType().Name;
			entry["displacement"] = TryGet(() => target.Displacement, 0);
			entry["barCount"]     = barCount;
			try
			{
				entry["barsFrom"] = ExchangeTimeToUnixSeconds(bars.GetTime(0));
				entry["barsTo"]   = ExchangeTimeToUnixSeconds(bars.GetTime(barCount - 1));
			}
			catch { /* the loaded window is informational */ }

			// Resolve the request to an absolute [lo, hi) bar-index window.
			int lo = 0, hi = barCount;
			if (q.LastBars.HasValue)
			{
				lo = Math.Max(0, barCount - q.LastBars.Value);
			}
			else
			{
				try
				{
					if (q.FromTs.HasValue)
						lo = FirstBarAtOrAfter(bars, barCount, UnixSecondsToExchangeTime(q.FromTs.Value));
					if (q.ToTs.HasValue)
						hi = FirstBarAfter(bars, barCount, UnixSecondsToExchangeTime(q.ToTs.Value));
				}
				catch (Exception ex)
				{
					Log("indicator_values range resolve failed: " + ex.Message);
					lo = 0; hi = barCount;
				}
			}
			if (lo < 0) lo = 0;
			if (hi > barCount) hi = barCount;

			// Payload guard, keeping the NEWEST points: an over-wide window is nearly
			// always "recent history", and dropping the tail would hide exactly the
			// values the caller is watching.
			bool truncated = false;
			if (hi - lo > IndicatorValuesMaxPoints)
			{
				lo = hi - IndicatorValuesMaxPoints;
				truncated = true;
			}

			// Never throw past here: an unadded entry would make the builder report
			// "no open chart matches", hiding the real cause.
			try
			{
				entry["plots"] = ReadPlotValues(target, bars, lo, hi, truncated);
			}
			catch (Exception ex)
			{
				entry["found"]  = false;
				entry["reason"] = "reading plot values failed: " + ex.Message;
			}
			outList.Add(entry);
		}

		// Plots[] and Values[] are index-aligned but may differ in length, so the
		// series array drives the iteration and the name is best-effort.
		private static List<object> ReadPlotValues(
			NinjaTrader.Gui.NinjaScript.IndicatorRenderBase ind, Bars bars, int lo, int hi, bool truncated)
		{
			var plots  = new List<object>();
			var series = TryGet(() => ind.Values, (NinjaTrader.NinjaScript.Series<double>[]) null);
			var defs   = TryGet(() => ind.Plots,  (NinjaTrader.Gui.Plot[]) null);
			if (series == null) return plots;

			for (int p = 0; p < series.Length; p++)
			{
				var s = series[p];
				if (s == null) continue;

				string plotName = "Plot" + p;
				var def = defs != null && p < defs.Length ? defs[p] : null;
				if (def != null)
				{
					var n = TryGet(() => def.Name, (string) null);
					if (!string.IsNullOrEmpty(n)) plotName = n;
				}

				int count = TryGet(() => s.Count, 0); // snapshot ONCE and stay inside it
				int end   = Math.Min(hi, count);
				var points    = new List<object>();
				object availFrom = null, availTo = null;

				for (int k = lo; k < end; k++)
				{
					try
					{
						// Warm-up / retention wall — an unset point is not a zero.
						if (!s.IsValidDataPointAt(k)) continue;
						// ABSOLUTE index: the [] indexer is barsAgo, unusable from an
						// external reader, and reading off the indicator itself
						// (ind.GetValueAt) is the attested cause of always-0 values.
						double v = s.GetValueAt(k);
						if (!IsFinite(v)) continue; // bare NaN would be invalid JSON
						long ts = ExchangeTimeToUnixSeconds(bars.GetTime(k));
						if (availFrom == null) availFrom = ts;
						availTo = ts;
						points.Add(new Dictionary<string, object> { { "t", ts }, { "v", v } });
					}
					catch { /* a bad index never costs the rest of the range */ }
				}

				plots.Add(new Dictionary<string, object>
				{
					{ "name",          plotName },
					{ "values",        points },
					{ "availableFrom", availFrom },
					{ "availableTo",   availTo },
					{ "truncated",     truncated },
				});
			}
			return plots;
		}

		// Returns the error to send, or null.
		private static string TryParseIndicatorSelector(
			IDictionary<string, object> obj, IndicatorSelector q, string request)
		{
			q.SymbolFilter = GetString(obj, "symbol");
			if (string.IsNullOrEmpty(q.SymbolFilter)) return request + " requires symbol";
			q.TimeframeFilter = GetString(obj, "timeframe");
			// indicatorId, not id: the envelope's id is the correlation uuid.
			q.IndicatorId = GetInt(obj, "indicatorId");
			var match = GetDict(obj, "match");
			if (match != null)
			{
				q.MatchName   = GetString(match, "name");
				q.MatchParams = GetDict(match, "params");
			}
			if (!q.IndicatorId.HasValue && string.IsNullOrEmpty(q.MatchName))
				return request + " requires indicatorId or match.name";
			return null;
		}

		private static string NoMatchReason(ChartWalkResult walk, IndicatorSelector q)
		{
			return walk.Entries.Count > 0
				? "no indicator on the matching chart(s) answers that selector"
				: "no open chart matches symbol=" + q.SymbolFilter
					+ (string.IsNullOrEmpty(q.TimeframeFilter) ? "" : " timeframe=" + q.TimeframeFilter);
		}

		// id wins when present: a cheap int compare, no reflection. Otherwise the NT8
		// type name — short ("SMA") or full — plus every param the caller pinned.
		private static bool IndicatorMatches(
			NinjaTrader.Gui.NinjaScript.IndicatorRenderBase ind, IndicatorSelector q)
		{
			if (q.IndicatorId.HasValue)
				return TryGet(() => ind.IndicatorId, -1) == q.IndicatorId.Value;

			if (string.IsNullOrEmpty(q.MatchName)) return false;
			var t = ind.GetType();
			if (!string.Equals(t.Name, q.MatchName, StringComparison.OrdinalIgnoreCase)
				&& !string.Equals(t.FullName, q.MatchName, StringComparison.OrdinalIgnoreCase))
				return false;

			if (q.MatchParams == null || q.MatchParams.Count == 0) return true;
			foreach (var kv in q.MatchParams)
			{
				// IgnoreCase can raise AmbiguousMatchException; TryGet turns that into
				// "no match", the fail-closed answer.
				var p = TryGet(() => t.GetProperty(kv.Key,
					System.Reflection.BindingFlags.Public
					| System.Reflection.BindingFlags.Instance
					| System.Reflection.BindingFlags.IgnoreCase),
					(System.Reflection.PropertyInfo) null);
				if (p == null || !p.CanRead || p.GetIndexParameters().Length > 0) return false;
				object actual;
				try { actual = p.GetValue(ind, null); } catch { return false; }
				if (!ScalarEquals(actual, kv.Value)) return false;
			}
			return true;
		}

		// The wire carries JSON scalars while the property may be int/double/enum/bool/
		// string: compare numerically when both sides are numbers, else on invariant
		// string form (which is what covers enums and bools).
		private static bool ScalarEquals(object actual, object wanted)
		{
			if (actual == null || wanted == null) return actual == null && wanted == null;
			double a, b;
			if (TryToDouble(actual, out a) && TryToDouble(wanted, out b))
				return Math.Abs(a - b) < 1e-9;
			return string.Equals(ToInvariantString(actual), ToInvariantString(wanted),
				StringComparison.OrdinalIgnoreCase);
		}

		private static bool TryToDouble(object v, out double d)
		{
			d = 0;
			if (v == null || v is bool || v is Enum) return false; // compare those by name
			var s = v as string;
			if (s != null)
				return double.TryParse(s, System.Globalization.NumberStyles.Float,
					System.Globalization.CultureInfo.InvariantCulture, out d);
			try { d = Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); return true; }
			catch { return false; }
		}

		private static string ToInvariantString(object v)
		{
			if (v is Enum) return v.ToString();
			var c = v as IConvertible;
			if (c != null)
			{
				try { return c.ToString(System.Globalization.CultureInfo.InvariantCulture); }
				catch { /* fall through */ }
			}
			return v.ToString();
		}

		// request_set_indicator_params. NT8 applies a changed setting only by rebuilding
		// the indicator, as the Indicators dialog's Apply does, and has no API for that,
		// so the rebuild runs the chart's own reload command.

		private const int SetIndicatorParamsBudgetMs = 4_000;
		private const int IndicatorReloadWaitMs      = 10_000;
		private const int IndicatorReloadPollMs      = 200;
		private const int ReloadPhaseBudgetMs        = 15_000;
		private const int DispatcherReadBudgetMs     = 8_000;

		private class ReloadCandidate
		{
			public string Name;
			public System.Windows.Input.RoutedCommand Command;
			public System.Windows.IInputElement       Target;
		}

		private class IndicatorHit
		{
			public NinjaTrader.Gui.Chart.ChartTab                  Tab;
			public NinjaTrader.Gui.NinjaScript.IndicatorRenderBase Indicator;
			public string Window;
			public string Symbol;
			public string Timeframe;
			public int    IndicatorId;
		}

		private class ApplyOutcome
		{
			public bool         Applied;
			public string       Reason;
			public string       ReloadVia;   // null = never triggered
			public string       TypeName;
			public string       DisplayName;
			public List<object> Changed   = new List<object>();
			public List<object> Unchanged = new List<object>();
			public List<object> Errors    = new List<object>();
			public List<object> Params;
			public Dictionary<string, object> Coerced = new Dictionary<string, object>();
			public List<object> PreRefs = new List<object>();
		}

		private void HandleRequestSetIndicatorParams(IDictionary<string, object> obj)
		{
			var id = GetString(obj, "id");
			if (string.IsNullOrEmpty(id))
			{
				Log("request_set_indicator_params missing id; dropping");
				return;
			}
			Task.Run(async () =>
			{
				try { await BuildAndSendSetIndicatorParamsAsync(id, obj); }
				catch (Exception ex)
				{
					SendErrorResponse(id, "request_set_indicator_params failed: " + ex.Message);
				}
			});
		}

		private async Task BuildAndSendSetIndicatorParamsAsync(string id, IDictionary<string, object> obj)
		{
			var q = new IndicatorSelector();
			var selectorError = TryParseIndicatorSelector(obj, q, "request_set_indicator_params");
			if (selectorError != null)
			{
				SendErrorResponse(id, selectorError);
				return;
			}
			var wanted = GetDict(obj, "params");
			if (wanted == null || wanted.Count == 0)
			{
				SendErrorResponse(id, "request_set_indicator_params requires a non-empty params object");
				return;
			}

			var hits = new List<IndicatorHit>();
			var walk = await WalkChartTabsAsync(SetIndicatorParamsBudgetMs, "set_indicator_params",
				(title, tab, isActive, outList) => CollectIndicatorHits(title, tab, isActive, q, hits, outList));

			if (walk.Skipped > 0)
			{
				SendSetParamsRefusal(id, q, hits.Count > 0,
					walk.Skipped + " chart window(s) missed the " + SetIndicatorParamsBudgetMs
					+ "ms budget; refusing to write against a partial view of the open charts");
				return;
			}
			if (hits.Count == 0)
			{
				SendSetParamsRefusal(id, q, false, NoMatchReason(walk, q));
				return;
			}
			if (hits.Count > 1)
			{
				var where = new List<string>();
				foreach (var h in hits)
					where.Add(h.Symbol + " " + h.Timeframe + " id=" + h.IndicatorId);
				SendSetParamsRefusal(id, q, true,
					"selector matched " + hits.Count + " indicators (" + string.Join(", ", where.ToArray())
					+ "); pass indicatorId to name exactly one");
				return;
			}

			var hit = hits[0];
			var cc  = hit.Tab.ChartControl;
			var dispatcher = cc == null ? null : DispatcherOf(cc);
			if (dispatcher == null)
			{
				SendSetParamsRefusal(id, q, true,
					"the chart went away between locating the indicator and writing it");
				return;
			}

			var outcome = await ReadOnDispatcherAsync(dispatcher, () => ApplyIndicatorParams(cc, hit, wanted));
			if (outcome == null)
			{
				SendErrorResponse(id, "request_set_indicator_params: the chart's dispatcher never answered");
				return;
			}

			// reload: the retry after an unconfirmed rebuild, when nothing changed.
			Dictionary<string, object> rebuilt = null;
			bool forceReload = GetBool(obj, "reload") ?? false;
			if (outcome.Applied && (outcome.Changed.Count > 0 || forceReload))
				rebuilt = await RebuildAsync(dispatcher, cc, hit, outcome);

			string reason = outcome.Reason;
			if (reason == null && outcome.Applied && outcome.Changed.Count > 0 && rebuilt == null)
				reason = outcome.ReloadVia == null
					? "the values are set on the running instance, but no reload command on that chart would take them — press Apply in the indicator dialog"
					: "the values are set and " + outcome.ReloadVia
					  + " ran, but no rebuilt instance appeared — retry with reload:true, or press Apply in the indicator dialog";

			SendSetParamsResponse(id, q, hit, outcome, rebuilt, true, reason);
		}

		// Separate dispatcher turns, because NT8 re-runs every script inside the reload
		// call. One execution only: the same command is bound on several elements.
		private static async Task<Dictionary<string, object>> RebuildAsync(
			System.Windows.Threading.Dispatcher dispatcher, NinjaTrader.Gui.Chart.ChartControl cc,
			IndicatorHit hit, ApplyOutcome outcome)
		{
			var switched = await ReadOnDispatcherAsync(dispatcher, () => EnsureTabSelected(hit.Tab));
			if (switched) Log("set_indicator_params selected the indicator's tab before reloading");

			var candidates = await ReadOnDispatcherAsync(dispatcher, () => CollectReloadCandidates(cc));
			Dictionary<string, object> rebuilt = null;
			var deadline = DateTime.UtcNow.AddMilliseconds(ReloadPhaseBudgetMs);
			foreach (var candidate in candidates ?? new List<ReloadCandidate>())
			{
				if (DateTime.UtcNow >= deadline) break;
				var via = await ReadOnDispatcherAsync(dispatcher, () => TryExecuteReloadCandidate(candidate));
				if (via == null) continue;
				outcome.ReloadVia = via;
				rebuilt = await AwaitReloadedIndicatorAsync(
					dispatcher, cc, outcome.PreRefs, outcome.TypeName, outcome.Coerced,
					RemainingWait(deadline, IndicatorReloadWaitMs));
				break;
			}
			Log("set_indicator_params reload " + (outcome.ReloadVia ?? "not triggered")
				+ (rebuilt != null ? " CONFIRMED" : " UNCONFIRMED"));
			return rebuilt;
		}

		// Dispatcher-thread only. Adds each matching chart to outList for NoMatchReason.
		private static void CollectIndicatorHits(
			string windowTitle, NinjaTrader.Gui.Chart.ChartTab chartTab, bool isActive,
			IndicatorSelector q, List<IndicatorHit> hits, List<Dictionary<string, object>> outList)
		{
			var desc      = DescribeChartTab(windowTitle, chartTab, isActive);
			var symbol    = (desc["symbol"] as string) ?? "";
			var timeframe = (desc["timeframe"] as string) ?? "";
			if (!MatchesChartFilter(symbol, timeframe, q.SymbolFilter, q.TimeframeFilter)) return;

			var cc = chartTab.ChartControl;
			if (cc == null) return;
			outList.Add(desc);

			foreach (var ind in SnapshotIndicators(cc))
			{
				if (!IndicatorMatches(ind, q)) continue;
				var hit = new IndicatorHit
				{
					Tab         = chartTab,
					Indicator   = ind,
					Window      = (desc["window"] as string) ?? "Chart",
					Symbol      = symbol,
					Timeframe   = timeframe,
					IndicatorId = TryGet(() => ind.IndicatorId, -1),
				};
				// Windows are walked concurrently, one dispatcher each.
				lock (hits) hits.Add(hit);
			}
		}

		private void SendSetParamsRefusal(string id, IndicatorSelector q, bool found, string reason)
		{
			SendSetParamsResponse(id, q, null, new ApplyOutcome(), null, found, reason);
		}

		// Mirrored by setIndicatorParamsResponseMessageSchema.
		private void SendSetParamsResponse(string id, IndicatorSelector q, IndicatorHit hit,
			ApplyOutcome outcome, Dictionary<string, object> rebuilt, bool found, string reason)
		{
			var payload = new Dictionary<string, object>
			{
				{ "v",         1 },
				{ "id",        id },
				{ "type",      "set_indicator_params_response" },
				{ "found",     found },
				{ "applied",   outcome.Applied },
				{ "reloaded",  rebuilt != null },
				{ "symbol",    hit != null ? hit.Symbol : q.SymbolFilter },
				{ "changed",   outcome.Changed },
				{ "unchanged", outcome.Unchanged },
				{ "errors",    outcome.Errors },
				{ "params",    rebuilt != null ? rebuilt["params"] : (object) (outcome.Params ?? new List<object>()) },
			};
			var timeframe = hit != null ? hit.Timeframe : q.TimeframeFilter;
			if (!string.IsNullOrEmpty(timeframe)) payload["timeframe"] = timeframe;
			if (hit != null)
			{
				payload["window"] = hit.Window;
				payload["indicatorId"] = rebuilt != null ? rebuilt["indicatorId"] : (object) hit.IndicatorId;
			}
			if (outcome.TypeName != null) payload["name"] = outcome.TypeName;
			var displayName = rebuilt != null ? rebuilt["displayName"] : outcome.DisplayName;
			if (displayName != null) payload["displayName"] = displayName;
			if (reason != null) payload["reason"] = reason;

			SendFireAndForget(Json.Serialize(payload),
				"set_indicator_params_response id=" + id + " applied=" + outcome.Applied
				+ " changed=" + outcome.Changed.Count + " reloaded=" + (rebuilt != null)
				+ (outcome.ReloadVia != null ? " via=" + outcome.ReloadVia : "")
				+ (outcome.Applied || reason == null ? "" : " (" + reason + ")"));
		}

		// Dispatcher-thread only.
		private static ApplyOutcome ApplyIndicatorParams(
			NinjaTrader.Gui.Chart.ChartControl cc, IndicatorHit hit, IDictionary<string, object> wanted)
		{
			var outcome = new ApplyOutcome();
			var ind     = hit.Indicator;
			var t       = ind.GetType();
			outcome.TypeName    = t.FullName ?? t.Name;
			outcome.DisplayName = TryGet(() => ind.DisplayName, (string) null) ?? outcome.TypeName;

			bool present = false;
			foreach (var other in SnapshotIndicators(cc))
				if (object.ReferenceEquals(other, ind)) { present = true; break; }
			if (!present)
			{
				outcome.Reason = "the indicator left the chart between locating it and writing it (reload or close); re-run list_chart_indicators for a fresh id";
				return outcome;
			}

			bool strategyCheckRan;
			if (WindowHostsStrategy(cc, out strategyCheckRan))
			{
				outcome.Reason = "a chart tab in that window hosts a NinjaScript strategy, and the rebuild this write depends on stops and restarts running strategies; move the indicator to a window without one";
				return outcome;
			}
			if (!strategyCheckRan)
			{
				outcome.Reason = "could not determine whether that window hosts a NinjaScript strategy, and this refuses to drive a rebuild it cannot clear";
				return outcome;
			}

			// Validate everything before writing anything.
			var plan = PlanWrites(ind, wanted, outcome);
			if (plan == null) return outcome;
			if (outcome.Errors.Count > 0)
			{
				outcome.Coerced.Clear();
				outcome.Reason = "nothing was written: " + outcome.Errors.Count + " of "
					+ wanted.Count + " requested setting(s) did not validate";
				return outcome;
			}
			if (plan.Count == 0)
			{
				outcome.Applied = true;
				outcome.Params  = ReadIndicatorParams(ind);
				outcome.Reason  = "every requested value already matched; nothing written and no reload";
				return outcome;
			}

			foreach (var step in plan)
			{
				var prop = step.Item1;
				try
				{
					prop.SetValue(ind, step.Item2, null);
					outcome.Changed.Add(new Dictionary<string, object>
					{
						{ "name", prop.Name },
						{ "from", step.Item3 },
						{ "to",   WireScalar(step.Item2) },
					});
				}
				catch (Exception ex)
				{
					outcome.Errors.Add(new Dictionary<string, object>
					{
						{ "name",   prop.Name },
						{ "reason", "setter threw: " + ex.Message },
					});
					// Not written, so not waited on.
					outcome.Coerced.Remove(prop.Name);
				}
			}
			outcome.Applied = outcome.Changed.Count > 0;
			outcome.Params  = ReadIndicatorParams(ind);
			if (!outcome.Applied)
			{
				outcome.Reason = "nothing was written: every setter threw";
				return outcome;
			}

			// A rebuild is proved by an instance outside this set.
			outcome.PreRefs = new List<object>();
			foreach (var other in SnapshotIndicators(cc))
			{
				var ot = other.GetType();
				if ((ot.FullName ?? ot.Name) == outcome.TypeName) outcome.PreRefs.Add(other);
			}

			Log("set_indicator_params " + hit.Symbol + " " + hit.Timeframe + " " + outcome.DisplayName
				+ ": " + outcome.Changed.Count + " setting(s) written");
			return outcome;
		}

		// (property, new value, current value) per change; null if the property scan fails.
		private static List<Tuple<System.Reflection.PropertyInfo, object, object>> PlanWrites(
			object ind, IDictionary<string, object> wanted, ApplyOutcome outcome)
		{
			var settable = new Dictionary<string, System.Reflection.PropertyInfo>(
				StringComparer.OrdinalIgnoreCase);
			try
			{
				var props = ind.GetType().GetProperties(System.Reflection.BindingFlags.Public
					| System.Reflection.BindingFlags.Instance);
				foreach (var p in props)
				{
					if (!IsIndicatorParam(p)) continue;
					if (!p.CanWrite || p.GetSetMethod() == null) continue;
					if (!settable.ContainsKey(p.Name)) settable[p.Name] = p;
				}
			}
			catch (Exception ex)
			{
				outcome.Reason = "property scan failed: " + ex.Message;
				return null;
			}

			var plan = new List<Tuple<System.Reflection.PropertyInfo, object, object>>();
			foreach (var kv in wanted)
			{
				System.Reflection.PropertyInfo p;
				if (!settable.TryGetValue(kv.Key, out p))
				{
					outcome.Errors.Add(new Dictionary<string, object>
					{
						{ "name",   kv.Key },
						{ "reason", "not a settable setting on " + outcome.DisplayName
							+ "; list_chart_indicators names the ones that are" },
					});
					continue;
				}
				object coerced;
				string error;
				if (!TryCoerceParam(p, kv.Value, out coerced, out error))
				{
					outcome.Errors.Add(new Dictionary<string, object>
					{
						{ "name",   p.Name },
						{ "reason", error },
					});
					continue;
				}
				object current = null;
				try { current = p.GetValue(ind, null); } catch { /* unreadable: treat as a change */ }

				outcome.Coerced[p.Name] = coerced;
				if (ValueEquals(current, coerced, p.PropertyType)) outcome.Unchanged.Add(p.Name);
				else plan.Add(Tuple.Create(p, coerced, WireScalar(current)));
			}
			return plan;
		}

		// Runtime cast, so nothing compiles against NT8's class hierarchy.
		private static System.Windows.Window WindowOf(object o)
		{
			var node = o as System.Windows.DependencyObject;
			if (node == null) return null;
			try { return System.Windows.Window.GetWindow(node); }
			catch { return null; }
		}

		private static List<KeyValuePair<System.Windows.Controls.TabItem,
			NinjaTrader.Gui.Chart.ChartTab>> ChartTabsOf(NinjaTrader.Gui.Chart.Chart chart)
		{
			var tabs = new List<KeyValuePair<System.Windows.Controls.TabItem,
				NinjaTrader.Gui.Chart.ChartTab>>();
			if (chart == null) return tabs;
			try
			{
				var tabControl = chart.MainTabControl;
				if (tabControl == null) return tabs;
				foreach (var item in tabControl.Items)
				{
					var tabItem  = item as System.Windows.Controls.TabItem;
					var chartTab = tabItem != null
						? tabItem.Content as NinjaTrader.Gui.Chart.ChartTab
						: null;
					if (chartTab != null)
						tabs.Add(new KeyValuePair<System.Windows.Controls.TabItem,
							NinjaTrader.Gui.Chart.ChartTab>(tabItem, chartTab));
				}
			}
			catch (Exception ex) { Log("chart tab walk failed: " + ex.Message); }
			return tabs;
		}

		// Reloading restarts running strategies, so every tab is checked. checkRan false
		// means the scan could not run.
		private static bool WindowHostsStrategy(
			NinjaTrader.Gui.Chart.ChartControl cc, out bool checkRan)
		{
			checkRan = false;
			bool ran;
			if (ChartHostsStrategy(cc, out ran)) { checkRan = true; return true; }
			checkRan = ran;

			foreach (var entry in ChartTabsOf(WindowOf(cc) as NinjaTrader.Gui.Chart.Chart))
			{
				var other = entry.Value.ChartControl;
				if (other == null || object.ReferenceEquals(other, cc)) continue;
				bool tabRan;
				if (ChartHostsStrategy(other, out tabRan)) { checkRan = true; return true; }
				checkRan = checkRan || tabRan;
			}
			return false;
		}

		// Matched by type name, so nothing compiles against NT8's strategy types.
		private static bool ChartHostsStrategy(
			NinjaTrader.Gui.Chart.ChartControl cc, out bool checkRan)
		{
			checkRan = false;
			try
			{
				var panels = cc.ChartPanels;
				if (panels == null) return false;
				foreach (var panel in panels)
				{
					if (panel == null || panel.ChartObjects == null) continue;
					checkRan = true;
					foreach (var co in panel.ChartObjects)
					{
						if (co == null) continue;
						for (var t = co.GetType(); t != null; t = t.BaseType)
						{
							var n = t.FullName ?? "";
							if (n.StartsWith("NinjaTrader.NinjaScript.Strategies.")
								|| n.EndsWith("StrategyRenderBase")) return true;
						}
					}
				}
			}
			catch (Exception ex) { Log("strategy scan failed: " + ex.Message); }
			return false;
		}

		// In case the reload rebuilds only the visible tab. True when it switched.
		private static bool EnsureTabSelected(NinjaTrader.Gui.Chart.ChartTab tab)
		{
			if (tab == null) return false;
			var chart = WindowOf(tab) as NinjaTrader.Gui.Chart.Chart;
			if (chart == null) return false;
			try
			{
				var tabControl = chart.MainTabControl;
				foreach (var entry in ChartTabsOf(chart))
				{
					if (!object.ReferenceEquals(entry.Value, tab)) continue;
					if (object.ReferenceEquals(tabControl.SelectedItem, entry.Key)) return false;
					tabControl.SelectedItem = entry.Key;
					return true;
				}
			}
			catch (Exception ex) { Log("tab select failed: " + ex.Message); }
			return false;
		}

		// Dispatcher-thread only.
		private static List<ReloadCandidate> CollectReloadCandidates(
			NinjaTrader.Gui.Chart.ChartControl cc)
		{
			var found = new List<ReloadCandidate>();
			object ccObj = cc;
			var d = ccObj as System.Windows.DependencyObject;
			while (d != null)
			{
				var el = d as System.Windows.UIElement;
				if (el != null) CollectFromCommandBindings(el, found);
				System.Windows.DependencyObject next = null;
				try { next = System.Windows.Media.VisualTreeHelper.GetParent(d); }
				catch { /* non-visual ancestor */ }
				if (next == null)
				{
					try { next = System.Windows.LogicalTreeHelper.GetParent(d); }
					catch { /* detached */ }
				}
				d = next;
			}
			return found;
		}

		// Matched on RoutedCommand.Name, which is not localized.
		private static void CollectFromCommandBindings(
			System.Windows.UIElement el, List<ReloadCandidate> found)
		{
			System.Windows.Input.CommandBindingCollection bindings = null;
			try { bindings = el.CommandBindings; } catch { return; }
			if (bindings == null) return;

			foreach (System.Windows.Input.CommandBinding cb in bindings)
			{
				try
				{
					var rc = cb.Command as System.Windows.Input.RoutedCommand;
					if (rc == null) continue;
					if (!NameLooksLikeReload(rc.Name)) continue;
					found.Add(new ReloadCandidate { Name = rc.Name, Command = rc, Target = el });
				}
				catch (Exception ex) { Log("command binding scan failed: " + ex.Message); }
			}
		}

		// Excludes "reload historical data", which re-downloads bars.
		private static bool NameLooksLikeReload(string n)
		{
			if (string.IsNullOrEmpty(n)) return false;
			var s = n.ToLowerInvariant().Replace(" ", "").Replace("_", "");
			if (s.Contains("historical") || s.Contains("data")) return false;
			return s.Contains("reloadninjascript") || s.Contains("reloadscript")
				|| s.Contains("reloadindicator") || s == "reload" || s.Contains("reloadall");
		}

		// Dispatcher-thread only. Null when the command declines.
		private static string TryExecuteReloadCandidate(ReloadCandidate c)
		{
			if (c == null || c.Command == null || c.Target == null) return null;
			try
			{
				if (!c.Command.CanExecute(null, c.Target)) return null;
				c.Command.Execute(null, c.Target);
				return c.Name;
			}
			catch (Exception ex) { Log("reload via " + c.Name + " failed: " + ex.Message); }
			return null;
		}

		// Polls because NT8 signals nothing when a rebuild finishes.
		private static async Task<Dictionary<string, object>> AwaitReloadedIndicatorAsync(
			System.Windows.Threading.Dispatcher dispatcher, NinjaTrader.Gui.Chart.ChartControl cc,
			List<object> preRefs, string typeName, IDictionary<string, object> coerced, int timeoutMs)
		{
			var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
			while (true)
			{
				var found = await ReadOnDispatcherAsync(dispatcher, () =>
				{
					foreach (var ind in SnapshotIndicators(cc))
					{
						if (IsKnownInstance(preRefs, ind)) continue;
						var t = ind.GetType();
						if ((t.FullName ?? t.Name) != typeName) continue;
						if (!ParamsMatch(ind, coerced)) continue;
						return new Dictionary<string, object>
						{
							{ "indicatorId", TryGet(() => ind.IndicatorId, -1) },
							{ "displayName", TryGet(() => ind.DisplayName, (string) null) ?? typeName },
							{ "params",      ReadIndicatorParams(ind) },
						};
					}
					return null;
				});
				if (found != null) return found;
				if (DateTime.UtcNow >= deadline) return null;
				await Task.Delay(IndicatorReloadPollMs);
			}
		}

		private static int RemainingWait(DateTime deadline, int preferredMs)
		{
			var left = (int) (deadline - DateTime.UtcNow).TotalMilliseconds;
			return left <= 0 ? 0 : Math.Min(preferredMs, left);
		}

		private static bool IsKnownInstance(List<object> refs, object candidate)
		{
			if (refs == null) return false;
			for (int i = 0; i < refs.Count; i++)
				if (object.ReferenceEquals(refs[i], candidate)) return true;
			return false;
		}

		private static bool ParamsMatch(object ind, IDictionary<string, object> coerced)
		{
			var t = ind.GetType();
			foreach (var kv in coerced)
			{
				var p = TryGet(() => t.GetProperty(kv.Key,
					System.Reflection.BindingFlags.Public
					| System.Reflection.BindingFlags.Instance
					| System.Reflection.BindingFlags.IgnoreCase),
					(System.Reflection.PropertyInfo) null);
				if (p == null || !p.CanRead) return false;
				object actual;
				try { actual = p.GetValue(ind, null); } catch { return false; }
				if (!ValueEquals(actual, kv.Value, p.PropertyType)) return false;
			}
			return true;
		}

		private static bool ValueEquals(object actual, object wanted, Type pt)
		{
			if (actual == null || wanted == null) return actual == null && wanted == null;
			if (pt == typeof(double) || pt == typeof(float) || pt == typeof(decimal))
			{
				double a, b;
				if (!TryToDouble(actual, out a) || !TryToDouble(wanted, out b)) return false;
				if (double.IsNaN(a) || double.IsNaN(b)) return false;
				var scale = Math.Max(1.0, Math.Max(Math.Abs(a), Math.Abs(b)));
				return Math.Abs(a - b) <= 1e-9 * scale;
			}
			// Ordinal: a case-only edit is a change.
			if (pt == typeof(string))
				return string.Equals(actual as string, wanted as string, StringComparison.Ordinal);
			return object.Equals(actual, wanted);
		}

		private static bool TryCoerceParam(
			System.Reflection.PropertyInfo prop, object raw, out object value, out string error)
		{
			value = null;
			error = null;
			var pt = prop.PropertyType;
			try
			{
				if (pt.IsEnum)
				{
					// Defined names only: Enum.Parse would accept "7" as (MyEnum) 7.
					var s = raw as string;
					if (s != null)
					{
						foreach (var name in Enum.GetNames(pt))
						{
							if (!string.Equals(name, s.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
							value = Enum.Parse(pt, name);
							return true;
						}
						error = "expects one of " + string.Join("|", Enum.GetNames(pt));
						return false;
					}
					double e;
					if (TryToDouble(raw, out e) && !double.IsNaN(e) && !double.IsInfinity(e))
					{
						var underlying = Convert.ChangeType((long) Math.Round(e),
							Enum.GetUnderlyingType(pt), System.Globalization.CultureInfo.InvariantCulture);
						if (Enum.IsDefined(pt, underlying)) { value = Enum.ToObject(pt, underlying); return true; }
					}
					error = "expects one of " + string.Join("|", Enum.GetNames(pt));
					return false;
				}
				if (pt == typeof(bool))
				{
					if (raw is bool) { value = raw; return true; }
					bool b;
					var s = raw as string;
					if (s != null && bool.TryParse(s, out b)) { value = b; return true; }
					error = "expects true or false";
					return false;
				}
				if (pt == typeof(string))
				{
					value = raw == null ? "" : ToInvariantString(raw);
					return true;
				}
				if (pt == typeof(char))
				{
					var s = raw == null ? "" : ToInvariantString(raw);
					if (s.Length != 1) { error = "expects a single character"; return false; }
					value = s[0];
					return true;
				}

				double num;
				if (raw is bool || !TryToDouble(raw, out num))
				{
					error = "expects a number";
					return false;
				}
				// "NaN" and "Infinity" parse as doubles.
				if (double.IsNaN(num) || double.IsInfinity(num))
				{
					error = "expects a finite number";
					return false;
				}
				if (!WithinDeclaredRange(prop, num, out error)) return false;

				if (pt == typeof(double) || pt == typeof(float) || pt == typeof(decimal))
				{
					value = Convert.ChangeType(num, pt, System.Globalization.CultureInfo.InvariantCulture);
					return true;
				}
				if (Math.Abs(num - Math.Round(num)) > 1e-9)
				{
					error = "expects a whole number";
					return false;
				}
				// ChangeType throws on an out-of-range value instead of wrapping silently.
				value = Convert.ChangeType(Math.Round(num), pt,
					System.Globalization.CultureInfo.InvariantCulture);
				return true;
			}
			catch (Exception ex)
			{
				value = null;
				error = "not a valid " + pt.Name + " (" + ex.Message + ")";
				return false;
			}
		}

		// An out-of-range value can make NT8 disable the indicator at load.
		private static bool WithinDeclaredRange(
			System.Reflection.PropertyInfo prop, double num, out string error)
		{
			error = null;
			try
			{
				var attrs = prop.GetCustomAttributes(
					typeof(System.ComponentModel.DataAnnotations.RangeAttribute), true);
				if (attrs.Length == 0) return true;
				var range = (System.ComponentModel.DataAnnotations.RangeAttribute) attrs[0];

				double min, max;
				if (!TryToDouble(range.Minimum, out min) || !TryToDouble(range.Maximum, out max))
					return true; // unreadable range: not enforced
				if (num >= min && num <= max) return true;

				error = "outside the setting's range "
					+ min.ToString(System.Globalization.CultureInfo.InvariantCulture) + " to "
					+ max.ToString(System.Globalization.CultureInfo.InvariantCulture);
				return false;
			}
			catch { return true; }
		}

		// Same value rules as ReadIndicatorParams.
		private static object WireScalar(object raw)
		{
			if (raw == null) return "";
			if (raw is Enum || raw is char) return raw.ToString();
			if (raw is double && !IsFinite((double) raw)) return "";
			if (raw is float  && !IsFinite((double)(float) raw)) return "";
			return raw;
		}

		private static System.Windows.Threading.Dispatcher DispatcherOf(object o)
		{
			var d = o as System.Windows.Threading.DispatcherObject;
			return d == null ? null : d.Dispatcher;
		}

		// InvokeAsync, never Invoke (deadlock risk). Budgeted, because a window closing
		// mid-request never runs the callback.
		private static async Task<T> ReadOnDispatcherAsync<T>(
			System.Windows.Threading.Dispatcher dispatcher, Func<T> read)
		{
			var task = DispatchReadAsync(dispatcher, read);
			var done = await Task.WhenAny(task, Task.Delay(DispatcherReadBudgetMs));
			if (!object.ReferenceEquals(done, task))
			{
				Log("dispatcher read exceeded " + DispatcherReadBudgetMs + "ms; treating as no answer");
				return default(T);
			}
			return await task;
		}

		private static Task<T> DispatchReadAsync<T>(
			System.Windows.Threading.Dispatcher dispatcher, Func<T> read)
		{
			var tcs = new TaskCompletionSource<T>();
			try
			{
				dispatcher.InvokeAsync(() =>
				{
					T value = default(T);
					try { value = read(); }
					catch (Exception ex) { Log("dispatcher read failed: " + ex.Message); }
					tcs.TrySetResult(value);
				});
			}
			catch (Exception ex)
			{
				// Window mid-close: its dispatcher is already shutting down.
				Log("dispatcher dispatch failed: " + ex.Message);
				tcs.TrySetResult(default(T));
			}
			return tcs.Task;
		}

		// Bar times ascend, so both bounds binary-search; both return `count` when
		// nothing qualifies. AtOrAfter is the earliest bar with time >= t; After is
		// strictly > t, i.e. the exclusive end of an inclusive [from, to] range.
		private static int FirstBarAtOrAfter(Bars bars, int count, DateTime t)
		{
			int lo = 0, hi = count;
			while (lo < hi)
			{
				int mid = lo + ((hi - lo) >> 1);
				if (bars.GetTime(mid) < t) lo = mid + 1;
				else                       hi = mid;
			}
			return lo;
		}

		private static int FirstBarAfter(Bars bars, int count, DateTime t)
		{
			int lo = 0, hi = count;
			while (lo < hi)
			{
				int mid = lo + ((hi - lo) >> 1);
				if (bars.GetTime(mid) <= t) lo = mid + 1;
				else                        hi = mid;
			}
			return lo;
		}
	}
}
