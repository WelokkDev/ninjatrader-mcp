#region Using declarations
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Windows.Media;
using NinjaTrader.Code;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript.AddOns;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

// Companion indicator for McpBridge. Drop this on any chart you want the AddOn to render zones on.
// It registers its symbol with the AddOn, subscribes to draw/clear events,
// and marshals rendering onto the NinjaScript thread via TriggerCustomEvent.
namespace NinjaTrader.NinjaScript.Indicators
{
	public class McpBridgeRenderer : Indicator
	{
		private const string TagPrefix      = "mcp_";
		private const int    AnchorBarsBack = 50; // fallback anchor when fromTs is omitted

		private string symbolKey;
		private bool   registered;

		private readonly ConcurrentQueue<DrawZoneCommand>  drawQueue
			= new ConcurrentQueue<DrawZoneCommand>();
		private readonly ConcurrentQueue<DrawCommand> drawCmdQueue
			= new ConcurrentQueue<DrawCommand>();
		private readonly ConcurrentQueue<ClearZonesCommand> clearQueue
			= new ConcurrentQueue<ClearZonesCommand>();

		private readonly HashSet<string> myTags = new HashSet<string>();

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description                  = @"Renders zones pushed from the MCP bridge.";
				Name                         = "McpBridgeRenderer";
				Calculate                    = Calculate.OnPriceChange;
				IsOverlay                    = true;
				DisplayInDataBox             = false;
				DrawOnPricePanel             = true;
				IsSuspendedWhileInactive     = false;
				PaintPriceMarkers            = false;
				ScaleJustification           = NinjaTrader.Gui.Chart.ScaleJustification.Right;
			}
			else if (State == State.DataLoaded)
			{
				symbolKey = Instrument != null && Instrument.MasterInstrument != null
					? Instrument.MasterInstrument.Name
					: null;

				if (symbolKey == null)
				{
					Log("no instrument; renderer disabled");
					return;
				}

				McpBridge.DrawZoneReceived   += OnDrawZoneReceived;
				McpBridge.DrawReceived       += OnDrawReceived;
				McpBridge.ClearZonesReceived += OnClearZonesReceived;

				TryRegister();
				if (!registered)
					Log("McpBridge not loaded yet; will register on next event");
				ReplayFromStore();
			}
			else if (State == State.Terminated)
			{
				McpBridge.DrawZoneReceived   -= OnDrawZoneReceived;
				McpBridge.DrawReceived       -= OnDrawReceived;
				McpBridge.ClearZonesReceived -= OnClearZonesReceived;

				if (registered && symbolKey != null && McpBridge.Instance != null)
				{
					McpBridge.Instance.UnregisterSymbol(symbolKey);
					registered = false;
				}
			}
		}

		// Cheap retry: if McpBridge wasn't loaded when this indicator attached,
		// register on the first inbound event so `hello.instruments` reflects us
		// the next time the AddOn reconnects.
		private void TryRegister()
		{
			if (registered || symbolKey == null) return;
			var bridge = McpBridge.Instance;
			if (bridge == null) return;
			bridge.RegisterSymbol(symbolKey);
			registered = true;
		}

		// Pull the AddOn's retained drawings for our symbol and queue them for (re)drawing.
		// Called on DataLoaded so drawings persist across chart data-series and timeframe changes.
		private void ReplayFromStore()
		{
			var bridge = McpBridge.Instance;
			if (bridge == null || symbolKey == null) return;
			try
			{
				var pending = bridge.GetDraws(symbolKey);
				if (pending == null || pending.Count == 0) return;
				foreach (var s in pending)
				{
					if (s == null) continue;
					if (s.Zone != null)      drawQueue.Enqueue(s.Zone);
					else if (s.Draw != null) drawCmdQueue.Enqueue(s.Draw);
				}
				TriggerCustomEvent(_ => DrainQueues(), null);
				Log("replayed " + pending.Count + " stored draw(s) for " + symbolKey);
			}
			catch (Exception ex) { Log("replay failed: " + ex.Message); }
		}

		// Bridge fires these on the WS reader thread — queue and marshal onto
		// the NinjaScript thread via TriggerCustomEvent before touching Draw.
		private void OnDrawZoneReceived(DrawZoneCommand cmd)
		{
			if (cmd == null || cmd.Symbol != symbolKey) return;
			TryRegister();
			drawQueue.Enqueue(cmd);
			TriggerCustomEvent(_ => DrainQueues(), null);
		}

		private void OnDrawReceived(DrawCommand cmd)
		{
			if (cmd == null || cmd.Symbol != symbolKey) return;
			TryRegister();
			drawCmdQueue.Enqueue(cmd);
			TriggerCustomEvent(_ => DrainQueues(), null);
		}

		private void OnClearZonesReceived(ClearZonesCommand cmd)
		{
			if (cmd == null) return;
			// Empty/missing symbol means "apply to every chart that has the renderer".
			if (!string.IsNullOrEmpty(cmd.Symbol) && cmd.Symbol != symbolKey) return;
			TryRegister();
			clearQueue.Enqueue(cmd);
			TriggerCustomEvent(_ => DrainQueues(), null);
		}

		protected override void OnBarUpdate()
		{
			DrainQueues();
		}

		private void DrainQueues()
		{
			if (CurrentBar < 0) return;

			DrawZoneCommand draw;
			while (drawQueue.TryDequeue(out draw))
			{
				try
				{
					var tag = TagPrefix + draw.Id;

					DateTime fromTime;
					if (draw.FromTime.HasValue)
					{
						fromTime = draw.FromTime.Value;
					}
					else
					{
						var startBar = Math.Min(AnchorBarsBack, CurrentBar);
						fromTime = Time[startBar];
					}

					var toTime = draw.ToTime.HasValue ? draw.ToTime.Value : Time[0];

					Brush brush;
					if (draw.Distal < draw.Proximal)      brush = Brushes.LimeGreen;
					else if (draw.Distal > draw.Proximal) brush = Brushes.OrangeRed;
					else                                   brush = Brushes.DodgerBlue;

					Draw.Rectangle(
						this,
						tag,
						false,
						fromTime, draw.Proximal,
						toTime,   draw.Distal,
						brush,
						brush,
						30);
					myTags.Add(tag);
					Log("drew " + tag + " " + draw.Proximal + "/" + draw.Distal
						+ " " + fromTime.ToString("yyyy-MM-dd HH:mm")
						+ "→" + toTime.ToString("yyyy-MM-dd HH:mm"));
				}
				catch (Exception ex) { Log("draw failed: " + ex.Message); }
			}

			DrawCommand dc;
			while (drawCmdQueue.TryDequeue(out dc))
			{
				try
				{
					var tag = TagPrefix + dc.Id;
					var fromTime = dc.FromTime.HasValue ? dc.FromTime.Value : Time[Math.Min(AnchorBarsBack, CurrentBar)];
					var toTime   = dc.ToTime.HasValue   ? dc.ToTime.Value   : Time[0];
					var atTime   = dc.AtTime.HasValue   ? dc.AtTime.Value   : Time[0];

					// Default rectangle color preserves the legacy direction heuristic
					// (demand=green, supply=red, neutral=blue) when no style.color is set.
					Brush dirBrush;
					if (dc.Distal < dc.Proximal)      dirBrush = Brushes.LimeGreen;
					else if (dc.Distal > dc.Proximal) dirBrush = Brushes.OrangeRed;
					else                               dirBrush = Brushes.DodgerBlue;

					var brush      = BrushFromHex(dc.Color, dc.Kind == "rectangle" ? dirBrush : Brushes.DodgerBlue);
					var areaOpacity = dc.Opacity.HasValue
						? Math.Max(0, Math.Min(100, (int) Math.Round(dc.Opacity.Value * 100)))
						: 30;

					switch (dc.Kind)
					{
						case "rectangle":
							Draw.Rectangle(this, tag, false, fromTime, dc.Proximal, toTime, dc.Distal, brush, brush, areaOpacity);
							break;
						case "hline":
							// The 4-arg overload defaults drawOnPricePanel to false, which
							// leaves the line unrendered on the price panel. Pass it explicitly.
							// isAutoScale=false so a distant line doesn't hijack the y-axis scale.
							Draw.HorizontalLine(this, tag, false, dc.Price, brush, true);
							break;
						case "vline":
							Draw.VerticalLine(this, tag, atTime, brush);
							break;
						case "text":
							Draw.Text(this, tag, dc.Text ?? "", BarsAgoFor(atTime), dc.Price, brush);
							break;
						default:
							Log("draw: unknown kind '" + dc.Kind + "'");
							continue;
					}
					myTags.Add(tag);

					// Optional companion label (skip for text, whose content IS the label).
					if (!string.IsNullOrEmpty(dc.Label) && dc.Kind != "text")
					{
						var lblTag   = tag + "__lbl";
						var lblTime  = dc.Kind == "vline" ? atTime : fromTime;
						var lblPrice = dc.Kind == "rectangle" ? Math.Max(dc.Proximal, dc.Distal)
							: dc.Kind == "hline" ? dc.Price : High[0];
						Draw.Text(this, lblTag, dc.Label, BarsAgoFor(lblTime), lblPrice, brush);
						myTags.Add(lblTag);
					}
					Log("drew " + dc.Kind + " " + tag);
				}
				catch (Exception ex) { Log("draw(generic) failed: " + ex.Message); }
			}

			ClearZonesCommand clr;
			while (clearQueue.TryDequeue(out clr))
			{
				try
				{
					if (clr.Ids != null && clr.Ids.Count > 0)
					{
						foreach (var rawId in clr.Ids)
						{
							if (string.IsNullOrEmpty(rawId)) continue;
							var tag = TagPrefix + rawId;
							RemoveDrawObject(tag);
							RemoveDrawObject(tag + "__lbl");
							myTags.Remove(tag);
							myTags.Remove(tag + "__lbl");
						}
						Log("cleared " + clr.Ids.Count + " ids on " + symbolKey);
					}
					else if (!string.IsNullOrEmpty(clr.Id))
					{
						var tag = TagPrefix + clr.Id;
						RemoveDrawObject(tag);
						RemoveDrawObject(tag + "__lbl");
						myTags.Remove(tag);
						myTags.Remove(tag + "__lbl");
						Log("cleared " + tag);
					}
					else
					{
						foreach (var tag in new List<string>(myTags))
							RemoveDrawObject(tag);
						myTags.Clear();
						Log("cleared all zones for " + symbolKey);
					}
				}
				catch (Exception ex) { Log("clear failed: " + ex.Message); }
			}
		}

		// Draw.Text has no clean DateTime overload (only int barsAgo or the full
		// 13-arg form), so map a chart time to barsAgo for text/label anchoring.
		private int BarsAgoFor(DateTime time)
		{
			int idx = Bars != null ? Bars.GetBar(time) : -1;
			if (idx < 0)          return CurrentBar; // before first loaded bar → oldest
			if (idx > CurrentBar) return 0;          // future → current bar
			return CurrentBar - idx;
		}

		private static Brush BrushFromHex(string hex, Brush fallback)
		{
			if (string.IsNullOrEmpty(hex)) return fallback;
			try
			{
				var c = (Color) ColorConverter.ConvertFromString(hex);
				var b = new SolidColorBrush(c);
				b.Freeze();
				return b;
			}
			catch { return fallback; }
		}

		private static void Log(string msg)
		{
			Output.Process("[McpBridgeRenderer] " + msg, PrintTo.OutputTab1);
		}
	}
}
