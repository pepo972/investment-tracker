// scripts/fetch_prices.cjs
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { createClient } = require("@supabase/supabase-js");
const yahooFinance = require("yahoo-finance2").default;

// --- Supabase ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Exchange → Yahoo symbol mapping ---
function toYahooSymbol(ticker, exchange) {
  if (!ticker) return "";
  switch (exchange) {
    case "LSE": return `${ticker}.L`;
    case "ST":  return `${ticker}.ST`;   // Stockholm
    case "F":   return `${ticker}.F`;    // Frankfurt
    case "NASDAQ":
    case "NYSE":
      return `${ticker}`;
    // Add as needed:
    // case "PA": return `${ticker}.PA`;   // Paris
    // case "AS": return `${ticker}.AS`;   // Amsterdam
    // case "MI": return `${ticker}.MI`;   // Milan
    // case "TO": return `${ticker}.TO`;   // Toronto
    default:    return ticker;
  }
}

// Build Yahoo FX pair like "SEKGBP=X" which returns GBP per 1 SEK
function fxPairToGBP(curr) {
  if (!curr || curr === "GBP" || curr === "GBX" || curr === "GBp") return null;
  return `${curr}GBP=X`;
}

async function fetchFxToGBP(curr) {
  const pair = fxPairToGBP(curr);
  if (!pair) return 1; // already GBP/GBX
  try {
    const q = await yahooFinance.quote(pair);
    const r = q?.regularMarketPrice;
    if (typeof r === "number" && isFinite(r)) return r; // GBP per 1 unit of 'curr'
  } catch (e) {
    console.log(`FX fetch failed for ${curr} -> GBP`, e.message);
  }
  return 0; // 0 means unknown; we’ll skip saving that price
}

async function main() {
  // 1) Get stocks from Supabase
  const { data: stocks, error } = await supabase
    .from("stocks")
    .select("ticker,exchange");
  if (error) {
    console.error("Failed to fetch stocks:", error.message);
    process.exit(1);
  }

  // 2) Deduplicate
  const uniq = Array.from(
    new Set(stocks.map(s => `${s.ticker}:${s.exchange}`))
  ).map(key => {
    const [ticker, exchange] = key.split(":");
    return { ticker, exchange };
  });

  // 3) Fetch quotes and normalize to GBP
  const rows = [];
  for (const { ticker, exchange } of uniq) {
    const symbol = toYahooSymbol(ticker, exchange);
    if (!symbol) continue;

    try {
      const q = await yahooFinance.quote(symbol);
      let price = q?.regularMarketPrice;
      const yc = q?.currency; // e.g., "USD", "SEK", "GBX", "GBP"

      if (typeof price !== "number" || !isFinite(price)) {
        console.log(`No numeric price for ${symbol}`);
        continue;
      }

      // GBX → GBP
      if (yc === "GBX" || yc === "GBp") {
        price = price / 100;
      }

      // Non-GBP (USD, SEK, EUR, etc.) → convert to GBP using FX pair
      if (yc && yc !== "GBP" && yc !== "GBX" && yc !== "GBp") {
        const fx = await fetchFxToGBP(yc); // GBP per 1 unit of 'yc'
        if (!fx) {
          console.log(`Skipping ${symbol}: FX ${yc}->GBP unavailable`);
          continue;
        }
        price = price * fx;
      }

      rows.push({ symbol, price, last_updated: new Date().toISOString() });
      console.log(`✔ ${symbol} -> £${price.toFixed(4)}`);
    } catch (e) {
      console.log(`Error fetching ${symbol}:`, e.message);
    }
  }

  // 4) Upsert into price_cache
  for (const r of rows) {
    const { error: upErr } = await supabase
      .from("price_cache")
      .upsert([r], { onConflict: ["symbol"] });
    if (upErr) {
      console.log(`Upsert failed for ${r.symbol}:`, upErr.message);
    }
  }

  console.log(`Done. Updated ${rows.length} symbols.`);
  process.exit(0);
}

main();
