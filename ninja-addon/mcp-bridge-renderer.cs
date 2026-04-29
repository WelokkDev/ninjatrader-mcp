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
		private const string TagPrefix     = "mcp_";
		private const int    AnchorBarsBack = 50;

		private string symbolKey;

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

				McpBridge.DrawZoneReceived  += OnDrawZoneReceived;
				McpBridge.ClearZonesReceived += OnClearZonesReceived;

				if (McpBridge.Instance != null)
					McpBridge.Instance.RegisterSymbol(symbolKey);
				else
					Log("McpBridge not loaded yet; will register on next event");
			}
			else if (State == State.Terminated)
			{
				McpBridge.DrawZoneReceived  -= OnDrawZoneReceived;
				McpBridge.ClearZonesReceived -= OnClearZonesReceived;

				if (symbolKey != null && McpBridge.Instance != null)
					McpBridge.Instance.UnregisterSymbol(symbolKey);
			}
		}

		// Bridge fires these on the WS reader thread — queue and marshal onto
		// the NinjaScript thread via TriggerCustomEvent before touching Draw.
		private void OnDrawZoneReceived(DrawZoneCommand cmd)
		{
			if (cmd == null || cmd.Symbol != symbolKey) return;
			drawQueue.Enqueue(cmd);
			TriggerCustomEvent(_ => DrainQueues(), null);
		}

		private void OnClearZonesReceived(ClearZonesCommand cmd)
		{
			if (cmd == null || cmd.Symbol != symbolKey) return;
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
					var tag      = TagPrefix + draw.Id;
					var startBar = Math.Min(AnchorBarsBack, CurrentBar);
					Draw.Rectangle(
						this,
						tag,
						false,
						Time[startBar], draw.Proximal,
						Time[0],        draw.Distal,
						Brushes.DodgerBlue,
						Brushes.DodgerBlue,
						30);
					myTags.Add(tag);
					Log("drew " + tag + " " + draw.Proximal + "/" + draw.Distal);
				}
				catch (Exception ex) { Log("draw failed: " + ex.Message); }
			}

			ClearZonesCommand clr;
			while (clearQueue.TryDequeue(out clr))
			{
				try
				{
					if (!string.IsNullOrEmpty(clr.Id))
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
