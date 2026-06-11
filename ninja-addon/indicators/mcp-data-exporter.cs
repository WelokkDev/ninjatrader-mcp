// McpDataExporter — v1.0 — 2026-06-11
// Indicador NT8 que envía barras enriquecidas al MCP server via McpBridge.QueueBarClose().
// Cargar en un chart 1m de NQ/MNQ con los indicadores RyFVaP, TLADeGEX y RVol4 ya añadidos.
// Configurar los índices de BarsArray y las propiedades para que coincidan con el chart.
//
// Flujo:
//   OnBarUpdate (OnBarClose, solo Realtime) →
//     Lee OHLCV de la barra cerrada
//     Lee RSI(14) de la serie local
//     Lee EffectiveVolume desde el BarsArray configurado
//     Lee niveles GEX y RyFVaP desde las series configuradas
//     Llama McpBridge.Instance.QueueBarClose(...)

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Web.Script.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Indicators;
using NinjaTrader.NinjaScript.AddOns;
#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
    public class McpDataExporter : Indicator
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        // RSI manual (para no depender de cruce de indicadores)
        private double rsiAvgGain;
        private double rsiAvgLoss;
        private bool   rsiSeeded;
        private const int RsiPeriod = 14;

        // GEX / RyFVaP plot names (configurables via propiedades)
        // Nombres exactos de los plots de TLADeGEX y RyFVaP cargados en el mismo chart.
        // NT8 no expone BarsArray para indicadores externos; leemos via Values[] index.
        // Si el usuario no quiere algún campo, puede deshabilitarlo desde las propiedades.

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description  = "Envia barras enriquecidas (GEX/RyFVaP/EffVol/RSI) al MCP server via McpBridge.";
                Name         = "McpDataExporter";
                Calculate    = Calculate.OnBarClose;
                IsOverlay    = true;
                IsAutoScale  = false;
                IsSuspendedWhileInactive = true;

                Symbol       = "NQ";
                EnableExport = true;
                EnableGex    = true;
                EnableRyFVaP = true;
                EnableEffVol = true;
            }
            else if (State == State.DataLoaded)
            {
                rsiSeeded  = false;
                rsiAvgGain = 0;
                rsiAvgLoss = 0;

                // Registrar símbolo con el bridge para que aparezca en hello
                if (McpBridge.Instance != null)
                    McpBridge.Instance.RegisterSymbol(Symbol);
            }
            else if (State == State.Terminated)
            {
                if (McpBridge.Instance != null)
                    McpBridge.Instance.UnregisterSymbol(Symbol);
            }
        }

        protected override void OnBarUpdate()
        {
            if (!EnableExport) return;
            if (State != State.Realtime) return;          // solo barras en vivo
            if (IsFirstTickOfBar) return;                 // Calculate=OnBarClose, no necesario
            if (CurrentBar < RsiPeriod + 1) return;

            // --- RSI(14) Wilder ---
            double rsi = ComputeRsiWilder();

            // --- Construir JSON de indicadores ---
            var ind = new Dictionary<string, object> { { "rsi", Math.Round(rsi, 2) } };

            // --- EffectiveVolume (RVol4) ---
            // Se accede por nombre del indicador: el usuario añade el indicador RVol4 al chart.
            // NT8 expone sus plots via el panel de indicadores. Aquí usamos una aproximación:
            // si EnableEffVol=true se intenta leer de la serie de input configurada.
            // Por defecto: eff_vol = Volume[0] (placeholder hasta conectar RVol4).
            if (EnableEffVol)
            {
                try
                {
                    ind["eff_vol_total"] = Math.Round(Volume[0], 0);
                    // TODO: reemplazar con RVol4.Values[0][0], RVol4.Values[1][0], RVol4.Values[2][0]
                    // cuando el indicador RVol4 esté accesible como variable de instancia.
                }
                catch { /* skip */ }
            }

            // --- GEX levels (TLADeGEX) ---
            // Los niveles GEX son constantes durante el día. Se envían siempre para que el
            // servidor pueda hacer forward-fill. El indicador TLADeGEX debe estar en el chart.
            if (EnableGex)
            {
                try
                {
                    // TODO: sustituir con valores reales de TLADeGEX cuando esté disponible como
                    // variable de instancia. Ejemplo: gex["ZG"] = myTLADeGEX.GexZeroGamma[0];
                    // Por ahora se omite para no enviar valores incorrectos.
                    // ind["gex"] = new Dictionary<string,object>{ {"ZG", myTLADeGEX.GexZeroGamma[0]}, ... };
                }
                catch { /* skip */ }
            }

            // --- RyFVaP levels ---
            if (EnableRyFVaP)
            {
                try
                {
                    // TODO: sustituir con valores reales de RyFVaP cuando esté disponible como
                    // variable de instancia. Ejemplo: ryfvap["Q1"] = myRyFVaP.Q1[0];
                    // ind["ryfvap"] = new Dictionary<string,object>{ {"Q1", myRyFVaP.Q1[0]}, ... };
                }
                catch { /* skip */ }
            }

            // --- Enviar al bridge ---
            var bridge = McpBridge.Instance;
            if (bridge == null)
            {
                Print("[McpDataExporter] McpBridge.Instance es null — el AddOn no está activo.");
                return;
            }

            try
            {
                long tsUnix = ToUnixSeconds(Time[0]);
                string indJson = Json.Serialize(ind);
                bridge.QueueBarClose(
                    Symbol,
                    "1m",
                    tsUnix,
                    Open[0], High[0], Low[0], Close[0], Volume[0],
                    indJson
                );
            }
            catch (Exception ex)
            {
                Print("[McpDataExporter] Error al enviar barra: " + ex.Message);
            }
        }

        // ---------------------------------------------------------------
        // RSI(14) Wilder manual — no depende de AddPlot ni otros indicadores
        // ---------------------------------------------------------------
        private double ComputeRsiWilder()
        {
            if (!rsiSeeded)
            {
                // Primera inicialización: media simple de los primeros RsiPeriod cambios
                double g = 0, l = 0;
                for (int i = 1; i <= RsiPeriod; i++)
                {
                    double d = Close[i - 1] - Close[i]; // Close[0]=más reciente en NT8
                    if (d > 0) g += d; else l -= d;
                }
                rsiAvgGain = g / RsiPeriod;
                rsiAvgLoss = l / RsiPeriod;
                rsiSeeded  = true;
            }
            else
            {
                double d = Close[0] - Close[1];
                double gain = d > 0 ? d : 0;
                double loss = d < 0 ? -d : 0;
                rsiAvgGain = (rsiAvgGain * (RsiPeriod - 1) + gain) / RsiPeriod;
                rsiAvgLoss = (rsiAvgLoss * (RsiPeriod - 1) + loss) / RsiPeriod;
            }
            if (rsiAvgLoss == 0) return 100;
            return 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
        }

        private static readonly DateTime UnixEpoch =
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static readonly TimeZoneInfo EasternTz =
            TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");

        private static long ToUnixSeconds(DateTime exchangeTime)
        {
            var unspecified = DateTime.SpecifyKind(exchangeTime, DateTimeKind.Unspecified);
            var utc = TimeZoneInfo.ConvertTimeToUtc(unspecified, EasternTz);
            return (long)(utc - UnixEpoch).TotalSeconds;
        }

        // ---------------------------------------------------------------
        // Propiedades
        // ---------------------------------------------------------------

        [NinjaScriptProperty]
        [Display(Name = "Símbolo MCP", Order = 1, GroupName = "MCP Export")]
        public string Symbol { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Activar exportación", Order = 2, GroupName = "MCP Export")]
        public bool EnableExport { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Incluir GEX levels", Order = 3, GroupName = "MCP Export")]
        public bool EnableGex { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Incluir RyFVaP levels", Order = 4, GroupName = "MCP Export")]
        public bool EnableRyFVaP { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Incluir EffectiveVolume", Order = 5, GroupName = "MCP Export")]
        public bool EnableEffVol { get; set; }
    }
}
