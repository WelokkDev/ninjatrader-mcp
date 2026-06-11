#region Using declarations
using System;
using System.ComponentModel.DataAnnotations;
using System.IO;
using System.Reflection;
using System.Windows.Media;
using NinjaTrader.Code;
using NinjaTrader.Core;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.NinjaScript.Indicators.Generated;
using Newtonsoft.Json;
#endregion

// Renders a configurable set of SMAs from a preset JSON file.
// Preset path: Documents/NinjaTrader 8/sma-presets/<Preset>.json
//
// On non-daily charts (Minute / Second / Tick / Range / Volume): SMA 8, 20, 50, 89.
// On daily-and-above charts (Day / Week / Month / Year):           SMA 50, 100, 200.
// SMA 50 is rendered dotted on both.
//
// SMAConfig binding is generated from the JSON Schema via `npm run generate:csharp`
// (quicktype, attributes-only). Hand-editing SMAConfig.generated.cs is not supported —
// regenerate from the schema.
namespace NinjaTrader.NinjaScript.Indicators
{
	public class McpSma : Indicator
	{
		private const string PresetSubdir = "sma-presets";

		// Plot slot indices. All 7 plots are added at SetDefaults; only the  slots applicable to the chart's TF receive values
		private const int PlotSma8     = 0;
		private const int PlotSma20    = 1;
		private const int PlotSma50Tr  = 2; // SMA 50 on a non-daily chart
		private const int PlotSma89    = 3;
		private const int PlotSma50Dy  = 4; // SMA 50 on a daily chart
		private const int PlotSma100   = 5;
		private const int PlotSma200   = 6;

		private SMAConfig presetConfig;
		private bool      isDailyChart;

		// Cached SMA series, bound only for the periods in use on this chart's TF.
		private SMA sma8, sma20, sma50, sma89, sma100, sma200;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description                  = @"Renders SMAs (8/20/50/89 non-daily; 50/100/200 daily) from a preset JSON.";
				Name                         = "McpSma";
				Calculate                    = Calculate.OnBarClose;
				IsOverlay                    = true;
				DisplayInDataBox             = true;
				DrawOnPricePanel             = true;
				IsSuspendedWhileInactive     = false;
				PaintPriceMarkers            = false;
				ScaleJustification           = NinjaTrader.Gui.Chart.ScaleJustification.Right;

				Preset             = "book-defaults";

				// Plot placeholders; brushes are overridden from the preset in DataLoaded. Order here defines the Plots[i] indices used above.
				AddPlot(new Stroke(Brushes.Purple,                 2), PlotStyle.Line, "SMA 8");
				AddPlot(new Stroke(Brushes.Orange,                 2), PlotStyle.Line, "SMA 20");
				AddPlot(new Stroke(Brushes.Gray, DashStyleHelper.Dot, 2), PlotStyle.Line, "SMA 50 (trading)");
				AddPlot(new Stroke(Brushes.Blue,                   2), PlotStyle.Line, "SMA 89");
				AddPlot(new Stroke(Brushes.Gray, DashStyleHelper.Dot, 2), PlotStyle.Line, "SMA 50 (daily)");
				AddPlot(new Stroke(Brushes.Yellow,                 2), PlotStyle.Line, "SMA 100");
				AddPlot(new Stroke(Brushes.HotPink,                2), PlotStyle.Line, "SMA 200");
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
				presetConfig = LoadPreset(Preset);
				if (presetConfig == null) return;

				if (isDailyChart)
				{
					ApplyBrush(PlotSma50Dy, presetConfig.DailyChartColors.The50);
					ApplyBrush(PlotSma100,  presetConfig.DailyChartColors.The100);
					ApplyBrush(PlotSma200,  presetConfig.DailyChartColors.The200);

					sma50  = SMA(Closes[0], 50);
					sma100 = SMA(Closes[0], 100);
					sma200 = SMA(Closes[0], 200);
				}
				else
				{
					ApplyBrush(PlotSma8,    presetConfig.TradingChartColors.The8);
					ApplyBrush(PlotSma20,   presetConfig.TradingChartColors.The20);
					ApplyBrush(PlotSma50Tr, presetConfig.TradingChartColors.The50);
					ApplyBrush(PlotSma89,   presetConfig.TradingChartColors.The89);

					sma8  = SMA(Closes[0], 8);
					sma20 = SMA(Closes[0], 20);
					sma50 = SMA(Closes[0], 50);
					sma89 = SMA(Closes[0], 89);
				}
			}
		}

		protected override void OnBarUpdate()
		{
			if (presetConfig == null) return;
			if (CurrentBar < 0) return;

			if (isDailyChart)
			{
				if (sma50  != null) Values[PlotSma50Dy][0] = sma50[0];
				if (sma100 != null) Values[PlotSma100][0]  = sma100[0];
				if (sma200 != null) Values[PlotSma200][0]  = sma200[0];
			}
			else
			{
				if (sma8  != null) Values[PlotSma8][0]    = sma8[0];
				if (sma20 != null) Values[PlotSma20][0]   = sma20[0];
				if (sma50 != null) Values[PlotSma50Tr][0] = sma50[0];
				if (sma89 != null) Values[PlotSma89][0]   = sma89[0];
			}
		}

		private SMAConfig LoadPreset(string presetName)
		{
			if (string.IsNullOrWhiteSpace(presetName))
			{
				Log("Preset parameter is empty; indicator disabled");
				return null;
			}
			if (!IsSafePresetName(presetName))
			{
				Log("invalid Preset name '" + presetName + "' (allowed: alphanumeric, dash, underscore); indicator disabled");
				return null;
			}

			var presetPath = Path.Combine(Globals.UserDataDir, PresetSubdir, presetName + ".json");
			if (!File.Exists(presetPath))
			{
				Log("preset not found at '" + presetPath
					+ "' — create that file and reload this indicator");
				return null;
			}

			try
			{
				var json = File.ReadAllText(presetPath);
				var cfg  = JsonConvert.DeserializeObject<SMAConfig>(json, Converter.Settings);
				if (cfg == null)
				{
					Log("preset at '" + presetPath + "' deserialized to null; indicator disabled");
					return null;
				}
				Log("loaded preset '" + presetName + "' (version " + cfg.Version + ") from '" + presetPath + "'");
				return cfg;
			}
			catch (Exception ex)
			{
				Log("failed to parse preset at '" + presetPath + "': " + ex.Message);
				return null;
			}
		}

		private static bool IsSafePresetName(string n)
		{
			foreach (var c in n)
			{
				if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
			}
			return true;
		}

		private void ApplyBrush(int plotIdx, string brushName)
		{
			var brush = ResolveBrush(brushName);
			if (brush == null)
			{
				Log("unknown color '" + brushName + "' for plot '" + Plots[plotIdx].Name + "'; leaving placeholder");
				return;
			}
			Plots[plotIdx].Brush = brush;
		}

		// Look up a color by name against System.Windows.Media.Brushes (case-insensitive). 
		// Accepts any property on Brushes — "Purple", "Orange", "Gray", "Blue", "Yellow", "HotPink", etc. 
		// Hex strings like "#RRGGBB" may be added later
		private static Brush ResolveBrush(string name)
		{
			if (string.IsNullOrWhiteSpace(name)) return null;
			var prop = typeof(Brushes).GetProperty(name,
				BindingFlags.Public | BindingFlags.Static | BindingFlags.IgnoreCase);
			if (prop == null) return null;
			return prop.GetValue(null) as Brush;
		}

		private static void Log(string msg)
		{
			Output.Process("[McpSma] " + msg, PrintTo.OutputTab1);
		}

		#region Properties

		[NinjaScriptProperty]
		[Display(Name = "Preset", Description = "Preset file name (no .json) under Documents/NinjaTrader 8/sma-presets/", Order = 1, GroupName = "Parameters")]
		public string Preset { get; set; }

		#endregion
	}
}
