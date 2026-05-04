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

// Companion indicator for McpBridge. Drop this on any chart you want
// the AddOn to render zones on. It registers its symbol with the AddOn,
// subscribes to draw/clear events, and marshals rendering onto the
// NinjaScript thread via TriggerCustomEvent.
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

				// Adopt any pre-existing mcp_* draw objects so a reload of this
				// indicator doesn't orphan rectangles drawn by the previous instance.
				try
				{
					foreach (var d in DrawObjects)
					{
						if (d == null || string.IsNullOrEmpty(d.Tag)) continue;
						if (d.Tag.StartsWith(TagPrefix)) myTags.Add(d.Tag);
					}
					if (myTags.Count > 0)
						Log("adopted " + myTags.Count + " existing mcp_* draw objects on " + symbolKey);
				}
				catch (Exception ex) { Log("tag adoption failed: " + ex.Message); }

				McpBridge.DrawZoneReceived   += OnDrawZoneReceived;
				McpBridge.ClearZonesReceived += OnClearZonesReceived;

				TryRegister();
				if (!registered)
					Log("McpBridge not loaded yet; will register on next event");
			}
			else if (State == State.Terminated)
			{
				McpBridge.DrawZoneReceived   -= OnDrawZoneReceived;
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

		// Bridge fires these on the WS reader thread — queue and marshal onto
		// the NinjaScript thread via TriggerCustomEvent before touching Draw.
		private void OnDrawZoneReceived(DrawZoneCommand cmd)
		{
			if (cmd == null || cmd.Symbol != symbolKey) return;
			TryRegister();
			drawQueue.Enqueue(cmd);
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

					Draw.Rectangle(
						this,
						tag,
						false,
						fromTime, draw.Proximal,
						toTime,   draw.Distal,
						Brushes.DodgerBlue,
						Brushes.DodgerBlue,
						30);
					myTags.Add(tag);
					Log("drew " + tag + " " + draw.Proximal + "/" + draw.Distal
						+ " " + fromTime.ToString("yyyy-MM-dd HH:mm")
						+ "→" + toTime.ToString("yyyy-MM-dd HH:mm"));
				}
				catch (Exception ex) { Log("draw failed: " + ex.Message); }
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
							myTags.Remove(tag);
						}
						Log("cleared " + clr.Ids.Count + " ids on " + symbolKey);
					}
					else if (!string.IsNullOrEmpty(clr.Id))
					{
						var tag = TagPrefix + clr.Id;
						RemoveDrawObject(tag);
						myTags.Remove(tag);
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

		private static void Log(string msg)
		{
			Output.Process("[McpBridgeRenderer] " + msg, PrintTo.OutputTab1);
		}
	}
}
