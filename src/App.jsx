import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Exchange → Yahoo symbol mapping (for price_cache lookup)
function getYahooSymbol(ticker, exchange) {
  if (!ticker) return "";
  switch (exchange) {
    case "LSE": return `${ticker}.L`;
    case "ST":  return `${ticker}.ST`;  // Stockholm
    case "F":   return `${ticker}.F`;   // Frankfurt
    case "NASDAQ":
    case "NYSE":
      return `${ticker}`;
    default:    return ticker;
  }
}

function App() {
  const [openHoldings, setOpenHoldings] = useState([]);
  const [closedHoldings, setClosedHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [priceUpdateTime, setPriceUpdateTime] = useState(null);
  const [view, setView] = useState("open"); // "open" | "closed"

  // Totals derived from current view
  const totals = (() => {
    if (view === "open") {
      const cost = openHoldings.reduce((s, h) => s + (h.costOpen || 0), 0);
      const value = openHoldings.reduce((s, h) => s + (h.value || 0), 0);
      const gain = value - cost;
      const pct = cost > 0 ? gain / cost : null;
      return { cost, value, gain, pct };
    } else {
      const cost = closedHoldings.reduce((s, h) => s + (h.buyGBP || 0), 0);
      const proceeds = closedHoldings.reduce((s, h) => s + (h.sellGBP || 0), 0);
      const realized = proceeds - cost;
      const pct = cost > 0 ? realized / cost : null;
      return { cost, proceeds, realized, pct };
    }
  })();

  useEffect(() => {
    async function fetchAll() {
      setLoading(true);

      const { data: stocks } = await supabase.from("stocks").select("*");
      const { data: trades } = await supabase.from("trades").select("*");
      const { data: priceCache } = await supabase.from("price_cache").select("*");

      // Aggregate per stock
      const byStock = {};
      for (const trade of trades || []) {
        if (!trade.stock_id || !trade.trade_type) continue;
        const key = trade.stock_id;
        if (!byStock[key]) {
          byStock[key] = {
            buyQty: 0,
            buyGBP: 0,
            sellGBP: 0,
            shares: 0,
          };
        }
        const qty = Number(trade.quantity) || 0;
        const gbpVal = Number(trade.gbp_value) || 0; // historic GBP from your import

        if (trade.trade_type === "BUY") {
          byStock[key].buyQty += qty;
          byStock[key].buyGBP += gbpVal;
          byStock[key].shares += qty;
        } else if (trade.trade_type === "SELL") {
          byStock[key].sellGBP += gbpVal;
          byStock[key].shares -= qty;
        }
      }

      let latestUpdate = null;
      const open = [];
      const closed = [];

      for (const [stock_id, agg] of Object.entries(byStock)) {
        const s = (stocks || []).find((row) => row.id === stock_id);
        if (!s) continue;

        const symbol = getYahooSymbol(s.ticker, s.exchange);
        const priceObj = (priceCache || []).find((p) => p.symbol === symbol);
        const livePrice = priceObj ? Number(priceObj.price) : null; // already GBP
        const lastUpdated = priceObj ? priceObj.last_updated : null;
        if (lastUpdated && (!latestUpdate || lastUpdated > latestUpdate)) {
          latestUpdate = lastUpdated;
        }

        const avgCost = agg.buyQty > 0 ? agg.buyGBP / agg.buyQty : 0;

        if (agg.shares > 0) {
          // OPEN position math
          const costOpen = avgCost * agg.shares; // allocate average cost to remaining shares
          const value = typeof livePrice === "number" ? agg.shares * livePrice : costOpen;
          const gain = value - costOpen;

          open.push({
            ticker: s.ticker,
            name: s.name,
            exchange: s.exchange,
            currency: s.currency, // informational
            shares: agg.shares,
            avgCost,     // BEP in GBP
            costOpen,    // GBP cost of remaining shares
            livePrice,   // GBP
            value,       // GBP
            gain,        // GBP
          });
        } else if (agg.shares === 0 && (agg.buyGBP > 0 || agg.sellGBP > 0)) {
          // CLOSED position math
          const realized = agg.sellGBP - agg.buyGBP; // realized P&L in GBP

          closed.push({
            ticker: s.ticker,
            name: s.name,
            exchange: s.exchange,
            currency: s.currency,
            buyGBP: agg.buyGBP,
            sellGBP: agg.sellGBP,
            realized, // GBP
          });
        }
      }

      // Sort for nicer display (highest value/gain)
      open.sort((a, b) => (b.value || 0) - (a.value || 0));
      closed.sort((a, b) => (b.realized || 0) - (a.realized || 0));

      setOpenHoldings(open);
      setClosedHoldings(closed);
      setPriceUpdateTime(latestUpdate ? new Date(latestUpdate) : null);
      setLoading(false);
    }

    fetchAll();
    // eslint-disable-next-line
  }, []);

  const fmtGBP = (n) =>
    typeof n === "number" && isFinite(n)
      ? n.toLocaleString(undefined, { style: "currency", currency: "GBP" })
      : "-";

  const fmtPct = (p) =>
    typeof p === "number" && isFinite(p)
      ? p.toLocaleString(undefined, {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "-";

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center p-4">
      <h1 className="text-3xl font-bold mb-3">📊 Portfolio</h1>

      <div className="mb-2 text-gray-600 text-sm text-center">
        * Cost & BEP use historic GBP from your trade import<br />
        * Live prices are normalized to GBP by the backend script<br />
        {priceUpdateTime && (
          <span>Last price update: {priceUpdateTime.toLocaleString()}</span>
        )}
      </div>

      {/* Toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setView("open")}
          className={
            "px-3 py-1 rounded-lg " +
            (view === "open" ? "bg-black text-white" : "bg-white text-gray-700 border")
          }
        >
          Open positions
        </button>
        <button
          onClick={() => setView("closed")}
          className={
            "px-3 py-1 rounded-lg " +
            (view === "closed" ? "bg-black text-white" : "bg-white text-gray-700 border")
          }
        >
          Closed positions
        </button>
      </div>

      {/* Totals */}
      {view === "open" ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full max-w-5xl mb-6">
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Cost (Open)</div>
            <div className="text-lg font-semibold">{fmtGBP(totals.cost)}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Value</div>
            <div className="text-lg font-semibold">{fmtGBP(totals.value)}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Unrealized Gain</div>
            <div className={"text-lg font-semibold " + (totals.gain > 0 ? "text-green-600" : totals.gain < 0 ? "text-red-600" : "")}>
              {fmtGBP(totals.gain)}
            </div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Return % (Open)</div>
            <div className={"text-lg font-semibold " + (totals.pct > 0 ? "text-green-600" : totals.pct < 0 ? "text-red-600" : "")}>
              {fmtPct(totals.pct)}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full max-w-5xl mb-6">
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Cost (Closed)</div>
            <div className="text-lg font-semibold">{fmtGBP(totals.cost)}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Proceeds</div>
            <div className="text-lg font-semibold">{fmtGBP(totals.proceeds)}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Realized P&amp;L</div>
            <div className={"text-lg font-semibold " + (totals.realized > 0 ? "text-green-600" : totals.realized < 0 ? "text-red-600" : "")}>
              {fmtGBP(totals.realized)}
            </div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Return % (Closed)</div>
            <div className={"text-lg font-semibold " + (totals.pct > 0 ? "text-green-600" : totals.pct < 0 ? "text-red-600" : "")}>
              {fmtPct(totals.pct)}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div>Loading...</div>
      ) : view === "open" ? (
        <div className="bg-white shadow-xl rounded-xl p-6 w-full max-w-5xl">
          <table className="min-w-full table-auto">
            <thead>
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Exchange</th>
                <th className="px-3 py-2">Shares</th>
                <th className="px-3 py-2">BEP (GBP)</th>
                <th className="px-3 py-2">Cost (GBP)</th>
                <th className="px-3 py-2">Live Price (GBP)</th>
                <th className="px-3 py-2">Value (GBP)</th>
                <th className="px-3 py-2">Unrealized (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {openHoldings.length === 0 ? (
                <tr><td colSpan={9} className="text-gray-400 text-center py-6">No open positions</td></tr>
              ) : (
                openHoldings.map((h) => (
                  <tr key={h.ticker + h.exchange} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{h.ticker}</td>
                    <td className="px-3 py-2">{h.name}</td>
                    <td className="px-3 py-2">{h.exchange}</td>
                    <td className="px-3 py-2">{h.shares}</td>
                    <td className="px-3 py-2">{fmtGBP(h.avgCost)}</td>
                    <td className="px-3 py-2">{fmtGBP(h.costOpen)}</td>
                    <td className="px-3 py-2">{fmtGBP(h.livePrice)}</td>
                    <td className="px-3 py-2">{fmtGBP(h.value)}</td>
                    <td className={"px-3 py-2 " + (h.gain > 0 ? "text-green-600" : h.gain < 0 ? "text-red-600" : "")}>
                      {fmtGBP(h.gain)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white shadow-xl rounded-xl p-6 w-full max-w-5xl">
          <table className="min-w-full table-auto">
            <thead>
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Exchange</th>
                <th className="px-3 py-2">Cost (GBP)</th>
                <th className="px-3 py-2">Proceeds (GBP)</th>
                <th className="px-3 py-2">Realized P&amp;L (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {closedHoldings.length === 0 ? (
                <tr><td colSpan={6} className="text-gray-400 text-center py-6">No closed positions</td></tr>
              ) : (
                closedHoldings.map((h) => (
                  <tr key={h.ticker + h.exchange} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{h.ticker}</td>
                    <td className="px-3 py-2">{h.name}</td>
                    <td className="px-3 py-2">{h.exchange}</td>
                    <td className="px-3 py-2">{fmtGBP(h.buyGBP)}</td>
                    <td className="px-3 py-2">{fmtGBP(h.sellGBP)}</td>
                    <td className={"px-3 py-2 " + (h.realized > 0 ? "text-green-600" : h.realized < 0 ? "text-red-600" : "")}>
                      {fmtGBP(h.realized)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;
