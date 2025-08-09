import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Map to Yahoo symbol for price_cache lookup (we don't fetch here, just to match symbols)
function toYahooSymbol(ticker, exchange) {
  if (!ticker) return "";
  switch (exchange) {
    case "LSE": return `${ticker}.L`;
    case "ST":  return `${ticker}.ST`;   // Stockholm
    case "F":   return `${ticker}.F`;    // Frankfurt
    case "NASDAQ":
    case "NYSE":
      return `${ticker}`;
    default:    return ticker;
  }
}

// Local currency formatting (special-case GBX)
function fmtLocal(n, currency) {
  const num = Number(n);
  if (!isFinite(num)) return "-";
  if (currency === "GBX" || currency === "GBp") {
    return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GBX`;
  }
  try {
    return num.toLocaleString(undefined, { style: "currency", currency });
  } catch {
    // Fallback if currency code unknown
    return `${num.toLocaleString()} ${currency || ""}`;
  }
}

// GBP formatting
function fmtGBP(n) {
  const num = Number(n);
  return isFinite(num) ? num.toLocaleString(undefined, { style: "currency", currency: "GBP" }) : "-";
}

const FX_CACHE_KEY = "fxRatesGBPBase";
const FX_CACHE_TS_KEY = "fxRatesGBPBase_ts";
const FX_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Fetch GBP-base FX table for the set of needed currencies
async function getFxTables(neededCurrencies) {
  const needed = Array.from(neededCurrencies).filter(
    (c) => c && c !== "GBP" && c !== "GBX" && c !== "GBp"
  );
  if (needed.length === 0) {
    return {
      // local per GBP (GBP->local)
      fromGBP: {},
      // GBP per local (local->GBP)
      toGBP: {},
    };
  }

  // Try cache first
  try {
    const cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "null");
    const ts = Number(localStorage.getItem(FX_CACHE_TS_KEY) || 0);
    if (cached && Date.now() - ts < FX_TTL_MS) {
      return cached;
    }
  } catch {}

  // Fetch once from exchangerate.host (free/no key)
  const symbols = needed.join(",");
  const url = `https://api.exchangerate.host/latest?base=GBP&symbols=${encodeURIComponent(symbols)}`;
  const res = await fetch(url);
  const data = await res.json();

  const fromGBP = data?.rates || {};
  const toGBP = {};
  for (const [cur, localPerGBP] of Object.entries(fromGBP)) {
    toGBP[cur] = localPerGBP ? 1 / localPerGBP : 0;
  }

  const payload = { fromGBP, toGBP };
  try {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify(payload));
    localStorage.setItem(FX_CACHE_TS_KEY, String(Date.now()));
  } catch {}

  return payload;
}

function App() {
  const [view, setView] = useState("open"); // "open" | "closed"
  const [openRows, setOpenRows] = useState([]);
  const [closedRows, setClosedRows] = useState([]);
  const [priceUpdateTime, setPriceUpdateTime] = useState(null);
  const [loading, setLoading] = useState(true);

  // Totals per current view
  const totals = (() => {
    if (view === "open") {
      const totalValueGBP = openRows.reduce((s, r) => s + (r.valueGBP || 0), 0);
      const totalCostOpenGBP = openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0);
      const gain = totalValueGBP - totalCostOpenGBP;
      const pct = totalCostOpenGBP > 0 ? gain / totalCostOpenGBP : null;
      return { valueGBP: totalValueGBP, costGBP: totalCostOpenGBP, gainGBP: gain, pct };
    } else {
      const costGBP = closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0);
      const realizedGBP = closedRows.reduce((s, r) => s + (r.realizedGBP || 0), 0);
      const pct = costGBP > 0 ? realizedGBP / costGBP : null;
      return { costGBP, realizedGBP, pct };
    }
  })();

  useEffect(() => {
    async function run() {
      setLoading(true);
  
      // 1) Pull data
      const { data: stocks } = await supabase.from("stocks").select("*");
      const { data: trades } = await supabase.from("trades").select("*");
      const { data: priceCache } = await supabase.from("price_cache").select("*");
  
      // 2) Build per-stock aggregates (use quantity sign directly)
      //    BUY rows have qty > 0, SELL rows have qty < 0 in your data.
      const agg = {}; // stock_id -> { buyQty, sellQty, buyLocal, sellLocal, buyGBP, sellGBP }
      for (const t of trades || []) {
        if (!t.stock_id) continue;
        const key = t.stock_id;
  
        const qty = Number(t.quantity) || 0;            // BUY > 0, SELL < 0
        const ppsLocal = Number(t.price_per_share) || 0; // local price at trade time
        const gbpVal = Number(t.gbp_value) || 0;         // GBP value at trade time
  
        if (!agg[key]) {
          agg[key] = {
            buyQty: 0, sellQty: 0,
            buyLocal: 0, sellLocal: 0,
            buyGBP: 0, sellGBP: 0,
          };
        }
  
        if (qty > 0) {
          // BUY
          agg[key].buyQty   += qty;
          agg[key].buyLocal += qty * ppsLocal;
          agg[key].buyGBP   += gbpVal;
        } else if (qty < 0) {
          // SELL
          const q = Math.abs(qty);
          agg[key].sellQty   += q;
          agg[key].sellLocal += q * ppsLocal;
          agg[key].sellGBP   += Math.abs(gbpVal); // make proceeds positive
        }
      }
  
      // 3) FX table for GBP<->local (for rendering local + GBP)
      const neededCurrencies = new Set((stocks || []).map((s) => s.currency).filter(Boolean));
      const { fromGBP, toGBP } = await (async function getFxTables(neededCurrencies) {
        const needed = Array.from(neededCurrencies).filter(
          (c) => c && c !== "GBP" && c !== "GBX" && c !== "GBp"
        );
        if (needed.length === 0) return { fromGBP: {}, toGBP: {} };
  
        const FX_CACHE_KEY = "fxRatesGBPBase";
        const FX_CACHE_TS_KEY = "fxRatesGBPBase_ts";
        const FX_TTL_MS = 12 * 60 * 60 * 1000;
  
        try {
          const cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "null");
          const ts = Number(localStorage.getItem(FX_CACHE_TS_KEY) || 0);
          if (cached && Date.now() - ts < FX_TTL_MS) return cached;
        } catch {}
  
        const symbols = needed.join(",");
        const url = `https://api.exchangerate.host/latest?base=GBP&symbols=${encodeURIComponent(symbols)}`;
        const res = await fetch(url);
        const data = await res.json();
  
        const fromGBP = data?.rates || {};
        const toGBP = {};
        for (const [cur, localPerGBP] of Object.entries(fromGBP)) {
          toGBP[cur] = localPerGBP ? 1 / localPerGBP : 0;
        }
  
        const payload = { fromGBP, toGBP };
        try {
          localStorage.setItem(FX_CACHE_KEY, JSON.stringify(payload));
          localStorage.setItem(FX_CACHE_TS_KEY, String(Date.now()));
        } catch {}
        return payload;
      })(neededCurrencies);
  
      // 4) Build open/closed rows
      let latest = null;
      const open = [];
      const closed = [];
  
      for (const [stock_id, a] of Object.entries(agg)) {
        const s = (stocks || []).find((row) => row.id === stock_id);
        if (!s) continue;
  
        const currency = s.currency || "GBP";
        const symbol = (function toYahooSymbol(ticker, exchange) {
          if (!ticker) return "";
          switch (exchange) {
            case "LSE": return `${ticker}.L`;
            case "ST":  return `${ticker}.ST`;
            case "F":   return `${ticker}.F`;
            case "NASDAQ":
            case "NYSE": return `${ticker}`;
            default:    return ticker;
          }
        })(s.ticker, s.exchange);
  
        const priceObj = (priceCache || []).find((p) => p.symbol === symbol);
        const priceGBP = priceObj ? Number(priceObj.price) : null; // backend saved as GBP
        const lastUpd = priceObj ? priceObj.last_updated : null;
        if (lastUpd && (!latest || lastUpd > latest)) latest = lastUpd;
  
        const buyQty = Number(a.buyQty) || 0;
        const sellQty = Number(a.sellQty) || 0;
        const shares = buyQty - sellQty; // exact, since we used abs for sells
  
        // Average cost per share
        const avgLocal = buyQty > 0 ? (a.buyLocal / buyQty) : 0; // local currency
        const avgGBP   = buyQty > 0 ? (a.buyGBP   / buyQty) : 0; // GBP
  
        // FX helpers
        const localPerGBP =
          currency === "GBP" ? 1 :
          (currency === "GBX" || currency === "GBp") ? 100 :
          (fromGBP?.[currency] || 0);
  
        // Live price shown in LOCAL currency
        const livePriceLocal =
          typeof priceGBP === "number" && isFinite(priceGBP) && localPerGBP
            ? priceGBP * localPerGBP
            : null;
  
        if (shares > 0) {
          // OPEN
          const costOpenLocal = avgLocal * shares; // local
          const costOpenGBP   = avgGBP   * shares; // GBP
  
          const valueLocal = typeof livePriceLocal === "number" ? shares * livePriceLocal : costOpenLocal;
          const valueGBP   = typeof priceGBP === "number" ? shares * priceGBP : costOpenGBP;
          const unrealizedGBP = valueGBP - costOpenGBP;
  
          open.push({
            ticker: s.ticker,
            name: s.name,
            exchange: s.exchange,
            currency,
            shares,
            avgLocal,
            costOpenLocal,
            livePriceLocal,
            valueLocal,
            costOpenGBP,
            valueGBP,
            unrealizedGBP,
          });
        } else if (shares === 0 && (a.buyGBP > 0 || a.sellGBP > 0 || a.buyLocal > 0 || a.sellLocal > 0)) {
          // CLOSED
          const realizedGBP  = a.sellGBP  - a.buyGBP;
          const realizedLocal = a.sellLocal - a.buyLocal; // info only
  
          closed.push({
            ticker: s.ticker,
            name: s.name,
            exchange: s.exchange,
            currency,
            buyLocal: a.buyLocal,
            sellLocal: a.sellLocal,
            buyGBP: a.buyGBP,
            sellGBP: a.sellGBP,
            realizedGBP,
            realizedLocal,
          });
        }
      }
  
      // Order for nicer display
      open.sort((a, b) => (b.valueGBP || 0) - (a.valueGBP || 0));
      closed.sort((a, b) => (b.realizedGBP || 0) - (a.realizedGBP || 0));
  
      setOpenRows(open);
      setClosedRows(closed);
      setPriceUpdateTime(latest ? new Date(latest) : null);
      setLoading(false);
    }
  
    run();
    // eslint-disable-next-line
  }, []);  

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center p-4">
      <h1 className="text-3xl font-bold mb-3">📊 Portfolio</h1>

      <div className="mb-2 text-gray-600 text-sm text-center">
        * Per-stock numbers (BEP, Cost, Live Price, Value) are in the stock's <b>local currency</b>.<br />
        * Final columns show <b>GBP</b> totals and P&amp;L.<br />
        {priceUpdateTime && <span>Last price update: {priceUpdateTime.toLocaleString()}</span>}
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
            <div className="text-xs text-gray-500">Total Cost (GBP, Open)</div>
            <div className="text-lg font-semibold">{fmtGBP(openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0))}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Value (GBP)</div>
            <div className="text-lg font-semibold">{fmtGBP(openRows.reduce((s, r) => s + (r.valueGBP || 0), 0))}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Unrealized P&amp;L (GBP)</div>
            <div className={
              "text-lg font-semibold " +
              ((openRows.reduce((s, r) => s + (r.valueGBP || 0), 0) - openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0)) > 0
                ? "text-green-600"
                : (openRows.reduce((s, r) => s + (r.valueGBP || 0), 0) - openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0)) < 0
                ? "text-red-600"
                : "")
            }>
              {fmtGBP(openRows.reduce((s, r) => s + (r.valueGBP || 0), 0) - openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0))}
            </div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Return % (Open)</div>
            <div className="text-lg font-semibold">
              {(() => {
                const cost = openRows.reduce((s, r) => s + (r.costOpenGBP || 0), 0);
                const value = openRows.reduce((s, r) => s + (r.valueGBP || 0), 0);
                return cost > 0 ? ((value - cost) / cost).toLocaleString(undefined, { style: "percent", minimumFractionDigits: 2 }) : "-";
              })()}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full max-w-5xl mb-6">
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Total Cost (GBP, Closed)</div>
            <div className="text-lg font-semibold">{fmtGBP(closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0))}</div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Realized P&amp;L (GBP)</div>
            <div className={
              "text-lg font-semibold " +
              ((closedRows.reduce((s, r) => s + (r.sellGBP || 0), 0) - closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0)) > 0
                ? "text-green-600"
                : (closedRows.reduce((s, r) => s + (r.sellGBP || 0), 0) - closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0)) < 0
                ? "text-red-600"
                : "")
            }>
              {fmtGBP(closedRows.reduce((s, r) => s + (r.sellGBP || 0), 0) - closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0))}
            </div>
          </div>
          <div className="bg-white shadow rounded-xl p-4">
            <div className="text-xs text-gray-500">Return % (Closed)</div>
            <div className="text-lg font-semibold">
              {(() => {
                const cost = closedRows.reduce((s, r) => s + (r.buyGBP || 0), 0);
                const realized = closedRows.reduce((s, r) => s + (r.realizedGBP || 0), 0);
                return cost > 0 ? (realized / cost).toLocaleString(undefined, { style: "percent", minimumFractionDigits: 2 }) : "-";
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Tables */}
      {loading ? (
        <div>Loading...</div>
      ) : view === "open" ? (
        <div className="bg-white shadow-xl rounded-xl p-6 w-full max-w-6xl overflow-x-auto">
          <table className="min-w-full table-auto">
            <thead>
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Exch</th>
                <th className="px-3 py-2">Cur</th>
                <th className="px-3 py-2">Shares</th>
                <th className="px-3 py-2">BEP (Local)</th>
                <th className="px-3 py-2">Cost (Local)</th>
                <th className="px-3 py-2">Live Price (Local)</th>
                <th className="px-3 py-2">Value (Local)</th>
                <th className="px-3 py-2">Value (GBP)</th>
                <th className="px-3 py-2">Unrealized (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {openRows.length === 0 ? (
                <tr><td colSpan={11} className="text-gray-400 text-center py-6">No open positions</td></tr>
              ) : (
                openRows.map((r) => (
                  <tr key={r.ticker + r.exchange} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{r.ticker}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2">{r.exchange}</td>
                    <td className="px-3 py-2">{r.currency}</td>
                    <td className="px-3 py-2">{r.shares}</td>
                    <td className="px-3 py-2">{fmtLocal(r.avgLocal, r.currency)}</td>
                    <td className="px-3 py-2">{fmtLocal(r.costOpenLocal, r.currency)}</td>
                    <td className="px-3 py-2">{fmtLocal(r.livePriceLocal, r.currency)}</td>
                    <td className="px-3 py-2">{fmtLocal(r.valueLocal, r.currency)}</td>
                    <td className="px-3 py-2">{fmtGBP(r.valueGBP)}</td>
                    <td className={"px-3 py-2 " + (r.unrealizedGBP > 0 ? "text-green-600" : r.unrealizedGBP < 0 ? "text-red-600" : "")}>
                      {fmtGBP(r.unrealizedGBP)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white shadow-xl rounded-xl p-6 w-full max-w-5xl overflow-x-auto">
          <table className="min-w-full table-auto">
            <thead>
              <tr>
                <th className="px-3 py-2">Ticker</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Exch</th>
                <th className="px-3 py-2">Cur</th>
                <th className="px-3 py-2">Cost (Local)</th>
                <th className="px-3 py-2">Proceeds (Local)</th>
                <th className="px-3 py-2">Realized (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {closedRows.length === 0 ? (
                <tr><td colSpan={7} className="text-gray-400 text-center py-6">No closed positions</td></tr>
              ) : (
                closedRows.map((r) => (
                  <tr key={r.ticker + r.exchange} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{r.ticker}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2">{r.exchange}</td>
                    <td className="px-3 py-2">{r.currency}</td>
                    <td className="px-3 py-2">{fmtLocal(r.buyLocal, r.currency)}</td>
                    <td className="px-3 py-2">{fmtLocal(r.sellLocal, r.currency)}</td>
                    <td className={"px-3 py-2 " + (r.realizedGBP > 0 ? "text-green-600" : r.realizedGBP < 0 ? "text-red-600" : "")}>
                      {fmtGBP(r.realizedGBP)}
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
