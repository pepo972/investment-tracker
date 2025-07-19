import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Maps your exchange codes to Yahoo Finance symbol format
function getYahooSymbol(ticker, exchange) {
  if (!ticker) return "";
  switch (exchange) {
    case "LSE":
      return `${ticker}.L`;
    case "ST":
      return `${ticker}.ST`;
    case "NASDAQ":
    case "NYSE":
      return `${ticker}`;
    case "F": // Frankfurt
      return `${ticker}.F`;
    default:
      return ticker;
  }
}

function App() {
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [priceUpdateTime, setPriceUpdateTime] = useState(null);

  useEffect(() => {
    async function fetchHoldingsAndPrices() {
      setLoading(true);

      // Fetch stocks, trades, and price cache
      const { data: stocks } = await supabase.from("stocks").select("*");
      const { data: trades } = await supabase.from("trades").select("*");
      const { data: priceCache } = await supabase.from("price_cache").select("*");

      // Aggregate holdings
      const byStock = {};
      trades.forEach((trade) => {
        if (!trade.stock_id || !trade.trade_type) return;
        const key = trade.stock_id;
        if (!byStock[key]) {
          byStock[key] = {
            totalShares: 0,
            totalGBPValue: 0,
            totalBuyQty: 0,
            ticker: "",
            name: "",
            exchange: "",
            currency: "",
          };
        }
        const sign = trade.trade_type === "BUY" ? 1 : trade.trade_type === "SELL" ? -1 : 0;
        byStock[key].totalShares += sign * (Number(trade.quantity) || 0);

        if (trade.trade_type === "BUY") {
          const qty = Number(trade.quantity) || 0;
          const gbpVal = Number(trade.gbp_value) || 0; // Imported as GBP at trade time
          byStock[key].totalGBPValue += gbpVal;
          byStock[key].totalBuyQty += qty;
        }
      });

      // Build the holdings table with prices from price_cache
      let latestUpdate = null;
      const holdingsArr = Object.entries(byStock)
        .filter(([_, h]) => h.totalShares > 0)
        .map(([stock_id, h]) => {
          const stock = stocks.find((s) => s.id === stock_id);

          const BEP_GBP = h.totalBuyQty > 0 ? h.totalGBPValue / h.totalBuyQty : 0; // GBP per share at historic rate
          const costGBP = h.totalGBPValue;

          const symbol = getYahooSymbol(stock?.ticker, stock?.exchange);
          const priceObj = priceCache?.find((p) => p.symbol === symbol);
          const livePrice = priceObj ? Number(priceObj.price) : null;
          const lastUpdated = priceObj ? priceObj.last_updated : null;
          if (lastUpdated && (!latestUpdate || lastUpdated > latestUpdate)) {
            latestUpdate = lastUpdated;
          }
          const value = typeof livePrice === "number"
            ? h.totalShares * livePrice
            : costGBP;
          const gain = typeof livePrice === "number"
            ? value - costGBP
            : 0;
          return {
            ticker: stock?.ticker || "",
            name: stock?.name || "",
            exchange: stock?.exchange || "",
            currency: stock?.currency || "",
            shares: h.totalShares,
            costGBP,
            BEP: BEP_GBP,
            livePrice,
            value,
            gain,
            lastUpdated,
          };
        });

      setHoldings(holdingsArr);
      setLoading(false);
      setPriceUpdateTime(latestUpdate ? new Date(latestUpdate) : null);
    }

    fetchHoldingsAndPrices();
    // eslint-disable-next-line
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <h1 className="text-3xl font-bold mb-6">📈 Your Current Holdings (Latest Prices)</h1>
      <div className="mb-2 text-gray-600 text-sm">
        * Cost and BEP are calculated in GBP using FX at trade time (from your trade import)<br />
        * Live prices are updated by your Node.js script.<br />
        {priceUpdateTime && (
          <span>
            Last price update: {priceUpdateTime.toLocaleString()}
          </span>
        )}
      </div>
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div className="bg-white shadow-xl rounded-xl p-6 min-w-[320px]">
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
                <th className="px-3 py-2">Gain (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {holdings.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-gray-400 text-center py-6">
                    No current holdings
                  </td>
                </tr>
              ) : (
                holdings.map((h, i) => (
                  <tr key={h.ticker + h.exchange} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{h.ticker}</td>
                    <td className="px-3 py-2">{h.name}</td>
                    <td className="px-3 py-2">{h.exchange}</td>
                    <td className="px-3 py-2">{h.shares}</td>
                    <td className="px-3 py-2">
                      {typeof h.BEP === "number" && !isNaN(h.BEP)
                        ? h.BEP.toLocaleString(undefined, {
                            style: "currency",
                            currency: "GBP",
                          })
                        : "-"}
                    </td>
                    <td className="px-3 py-2">
                      {typeof h.costGBP === "number" && !isNaN(h.costGBP)
                        ? h.costGBP.toLocaleString(undefined, {
                            style: "currency",
                            currency: "GBP",
                          })
                        : "-"}
                    </td>
                    <td className="px-3 py-2">
                      {typeof h.livePrice === "number" && !isNaN(h.livePrice)
                        ? h.livePrice.toLocaleString(undefined, {
                            style: "currency",
                            currency: "GBP",
                          })
                        : "-"}
                    </td>
                    <td className="px-3 py-2">
                      {typeof h.value === "number" && !isNaN(h.value)
                        ? h.value.toLocaleString(undefined, {
                            style: "currency",
                            currency: "GBP",
                          })
                        : "-"}
                    </td>
                    <td
                      className={
                        "px-3 py-2 " +
                        (h.gain > 0
                          ? "text-green-600"
                          : h.gain < 0
                          ? "text-red-600"
                          : "")
                      }
                    >
                      {typeof h.gain === "number" && !isNaN(h.gain)
                        ? h.gain.toLocaleString(undefined, {
                            style: "currency",
                            currency: "GBP",
                          })
                        : "-"}
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
