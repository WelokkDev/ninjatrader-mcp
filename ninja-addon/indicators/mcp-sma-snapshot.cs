#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.IO;
using NinjaTrader.Cbi;
using NinjaTrader.Code;
using NinjaTrader.Core;
using NinjaTrader.Data;
using Newtonsoft.Json;
#endregion

// One-shot snapshot writer. Drop on a chart, let it load historical bars, and a snapshot file lands at
// Documents/NinjaTrader 8/sma-parity/<symbol>-<tf>.json
// when the chart transitions from Historical to Realtime.
//
// Captures: per-bar OHLCV + per-bar NT8 SMA values for periods 8/20/50/89 (non-daily chart) or 50/100/200 (daily chart). 
// Intended for offline comparison against an external SMA implementation (sort of R&D for now, may remove/refactor usage at later point).
//
// File shape:
//   {
//     "symbol":     "<MasterInstrument.Name>",
//     "fullSymbol": "<Instrument.FullName>",
//     "timeframe":  "<formatted>",     // e.g. "5m", "1h", "1d"
//     "tickSize":   <double>,
//     "capturedAt": "<ISO-8601-UTC>",
//     "ntVersion":  "NT8",
//     "barCount":   <int>,
//     "candles":    [{"ts": <unix-sec>, "o", "h", "l", "c", "v"}],
//     "smas":       { "<period>": [<per-bar NT8 value>] }
//   }
//
// Note: NT8's SMA returns a cumulative average for bars before the rolling window fills (sum / (i+1)), not null. 
// The raw values are written here unchanged; consumers that want strict rolling-window semantics should skip the first `period-1` indices.
namespace NinjaTrader.NinjaScript.Indicators
{
	public class McpSmaSnapshot : Indicator
	{
		private const string OutSubdir = "sma-parity";

		private bool      isDailyChart;
		private SMA       sma8, sma20, sma50, sma89, sma100, sma200;

		private readonly List<object>                  candles   = new List<object>();
		private readonly Dictionary<int, List<object>> smaSeries = new Dictionary<int, List<object>>();
		private bool snapshotWritten;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description                  = @"One-shot snapshot writer. Captures bars + SMA values to Documents/NinjaTrader 8/sma-parity/<symbol>-<tf>.json on Realtime transition.";
				Name                         = "McpSmaSnapshot";
				Calculate                    = Calculate.OnBarClose;
				IsOverlay                    = true;
				DisplayInDataBox             = false;
				DrawOnPricePanel             = false;
				IsSuspendedWhileInactive     = true;
				PaintPriceMarkers            = false;

				MaxBars                      = 5000;
			}
			else if (State == State.Configure)
			{
				if (BarsPeriod != null)
				{
					var pt = BarsPeriod.BarsPeriodType;
					isDailyChart = pt == BarsPeriodType.Day
						|| pt == BarsPeriodType.Week
						|| pt == BarsPeriodType.Month
						|| pt == BarsPeriodType.Year;
				}
			}
			else if (State == State.DataLoaded)
			{
				if (isDailyChart)
				{
					sma50  = SMA(Closes[0], 50);
					sma100 = SMA(Closes[0], 100);
					sma200 = SMA(Closes[0], 200);
					smaSeries[50]  = new List<object>();
					smaSeries[100] = new List<object>();
					smaSeries[200] = new List<object>();
				}
				else
				{
					sma8  = SMA(Closes[0], 8);
					sma20 = SMA(Closes[0], 20);
					sma50 = SMA(Closes[0], 50);
					sma89 = SMA(Closes[0], 89);
					smaSeries[8]  = new List<object>();
					smaSeries[20] = new List<object>();
					smaSeries[50] = new List<object>();
					smaSeries[89] = new List<object>();
				}
			}
			else if (State == State.Realtime)
			{
				WriteSnapshot();
			}
		}

		protected override void OnBarUpdate()
		{
			if (CurrentBar < 0) return;
			if (snapshotWritten) return;
			if (candles.Count >= MaxBars) return;

			candles.Add(new
			{
				ts = ToUnixSec(Time[0]),
				o  = Open[0],
				h  = High[0],
				l  = Low[0],
				c  = Close[0],
				v  = (long)Volume[0],
			});

			if (isDailyChart)
			{
				smaSeries[50].Add(sma50[0]);
				smaSeries[100].Add(sma100[0]);
				smaSeries[200].Add(sma200[0]);
			}
			else
			{
				smaSeries[8].Add(sma8[0]);
				smaSeries[20].Add(sma20[0]);
				smaSeries[50].Add(sma50[0]);
				smaSeries[89].Add(sma89[0]);
			}
		}

		private void WriteSnapshot()
		{
			if (snapshotWritten) return;
			snapshotWritten = true;

			if (candles.Count == 0)
			{
				Log("no bars captured; skipping write");
				return;
			}

			var symbol = Instrument != null && Instrument.MasterInstrument != null
				? Instrument.MasterInstrument.Name
				: "UNKNOWN";
			var fullSymbol = Instrument != null ? Instrument.FullName : symbol;
			var tickSize   = Instrument != null && Instrument.MasterInstrument != null
				? Instrument.MasterInstrument.TickSize
				: 0.0;
			var tf = FormatTimeframe(BarsPeriod);

			var outDir  = Path.Combine(Globals.UserDataDir, OutSubdir);
			try { Directory.CreateDirectory(outDir); }
			catch (Exception ex)
			{
				Log("failed to create '" + outDir + "': " + ex.Message);
				return;
			}

			var fileName = symbol + "-" + tf + ".json";
			var outPath  = Path.Combine(outDir, fileName);

			var smasDict = new Dictionary<string, List<object>>();
			foreach (var kv in smaSeries)
			{
				smasDict[kv.Key.ToString()] = kv.Value;
			}

			var payload = new
			{
				symbol      = symbol,
				fullSymbol  = fullSymbol,
				timeframe   = tf,
				tickSize    = tickSize,
				capturedAt  = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
				ntVersion   = "NT8",
				barCount    = candles.Count,
				candles     = candles,
				smas        = smasDict,
			};

			try
			{
				var json = JsonConvert.SerializeObject(payload, Formatting.Indented);
				File.WriteAllText(outPath, json);
				Log("wrote " + candles.Count + " bars to '" + outPath + "'");
			}
			catch (Exception ex)
			{
				Log("failed to write '" + outPath + "': " + ex.Message);
			}
		}

		private static string FormatTimeframe(BarsPeriod bp)
		{
			if (bp == null) return "unknown";
			if (bp.BarsPeriodType == BarsPeriodType.Minute)
			{
				if (bp.Value < 60) return bp.Value + "m";
				if (bp.Value % 60 == 0) return (bp.Value / 60) + "h";
				return bp.Value + "m";
			}
			if (bp.BarsPeriodType == BarsPeriodType.Day && bp.Value == 1) return "1d";
			return bp.BarsPeriodType.ToString().ToLower() + bp.Value;
		}

		private static long ToUnixSec(DateTime t)
		{
			var utc = t.Kind == DateTimeKind.Utc ? t : t.ToUniversalTime();
			return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
		}

		private static void Log(string msg)
		{
			Output.Process("[McpSmaSnapshot] " + msg, PrintTo.OutputTab1);
		}

		[NinjaScriptProperty]
		[Display(Name = "Max Bars", Description = "Cap on captured bars (most recent). Default 5000.", Order = 1, GroupName = "Parameters")]
		public int MaxBars { get; set; }
	}
}
