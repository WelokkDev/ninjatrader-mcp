namespace NinjaTrader.NinjaScript.Indicators.Generated
{
    using System;
    using System.Collections.Generic;

    using System.Globalization;
    using Newtonsoft.Json;
    using Newtonsoft.Json.Converters;

    public partial class SmaConfig
    {
        [JsonProperty("crossovers", NullValueHandling = NullValueHandling.Ignore)]
        public Crossovers Crossovers { get; set; }

        [JsonProperty("dailyChartColors")]
        public DailyChartColors DailyChartColors { get; set; }

        [JsonProperty("periods")]
        public List<double> Periods { get; set; }

        [JsonProperty("preset")]
        public string Preset { get; set; }

        [JsonProperty("source")]
        public Source Source { get; set; }

        [JsonProperty("tradingChartColors")]
        public TradingChartColors TradingChartColors { get; set; }

        [JsonProperty("version", NullValueHandling = NullValueHandling.Ignore)]
        public string Version { get; set; }
    }

    public partial class Crossovers
    {
        [JsonProperty("alertOnCross", NullValueHandling = NullValueHandling.Ignore)]
        public bool? AlertOnCross { get; set; }

        [JsonProperty("enabled")]
        public bool Enabled { get; set; }
    }

    public partial class DailyChartColors
    {
        [JsonProperty("the100")]
        public string The100 { get; set; }

        [JsonProperty("the200")]
        public string The200 { get; set; }

        [JsonProperty("the50")]
        public string The50 { get; set; }
    }

    public partial class TradingChartColors
    {
        [JsonProperty("the20")]
        public string The20 { get; set; }

        [JsonProperty("the50")]
        public string The50 { get; set; }

        [JsonProperty("the8")]
        public string The8 { get; set; }

        [JsonProperty("the89")]
        public string The89 { get; set; }
    }

    public enum Source { Close, High, Hl2, Hlc3, Low, Open };

    internal static class Converter
    {
        public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            MetadataPropertyHandling = MetadataPropertyHandling.Ignore,
            DateParseHandling = DateParseHandling.None,
            Converters =
            {
                SourceConverter.Singleton,
                new IsoDateTimeConverter { DateTimeStyles = DateTimeStyles.AssumeUniversal }
            },
        };
    }

    internal class SourceConverter : JsonConverter
    {
        public override bool CanConvert(Type t) => t == typeof(Source) || t == typeof(Source?);

        public override object ReadJson(JsonReader reader, Type t, object existingValue, JsonSerializer serializer)
        {
            if (reader.TokenType == JsonToken.Null) return null;
            var value = serializer.Deserialize<string>(reader);
            switch (value)
            {
                case "close":
                    return Source.Close;
                case "high":
                    return Source.High;
                case "hl2":
                    return Source.Hl2;
                case "hlc3":
                    return Source.Hlc3;
                case "low":
                    return Source.Low;
                case "open":
                    return Source.Open;
            }
            throw new Exception("Cannot unmarshal type Source");
        }

        public override void WriteJson(JsonWriter writer, object untypedValue, JsonSerializer serializer)
        {
            if (untypedValue == null)
            {
                serializer.Serialize(writer, null);
                return;
            }
            var value = (Source)untypedValue;
            switch (value)
            {
                case Source.Close:
                    serializer.Serialize(writer, "close");
                    return;
                case Source.High:
                    serializer.Serialize(writer, "high");
                    return;
                case Source.Hl2:
                    serializer.Serialize(writer, "hl2");
                    return;
                case Source.Hlc3:
                    serializer.Serialize(writer, "hlc3");
                    return;
                case Source.Low:
                    serializer.Serialize(writer, "low");
                    return;
                case Source.Open:
                    serializer.Serialize(writer, "open");
                    return;
            }
            throw new Exception("Cannot marshal type Source");
        }

        public static readonly SourceConverter Singleton = new SourceConverter();
    }
}
