require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const yahooFinance = require("yahoo-finance2").default;

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Map to Yahoo symbols
function getYahooSymbol(ticker, exchange) {
  if (!ticker) return "";
  switch (exchange) {
    case "LSE":
      return `${ticker}.L`;
    case "ST":
      return `${ticker}.ST`;
    case "F":
      return `${ticker}.F`;
    case "NASDAQ":
    case "NYSE":
      return `${ticker}`;
    default:
      return ticker;
  }
}

// Main fetch and store logic
async function fetchAndCachePrices() {
  // --- Fetch all unique stocks from Supabase
  const { data: stocks, error } = await supabase.from("stocks").select("ticker,exchange");
  if (error) {
    console.error("Failed to fetch stocks from Supabase:", error.message);
    process.exit(1);
  }

  // Remove duplicates
  const uniqueStocks = Array.from(
    new Set(stocks.map((s) => `${s.ticker}:${s.exchange}`))
  ).map((key) => {
    const [ticker, exchange] = key.split(":");
    return { ticker, exchange };
  });

  // Fetch prices for each
  const results = [];
  for (const { ticker, exchange } of uniqueStocks) {
    const symbol = getYahooSymbol(ticker, exchange);
    if (!symbol) continue;
    try {
      console.log("Fetching:", symbol);
      const quote = await yahooFinance.quote(symbol);
      if (quote && quote.regularMarketPrice) {
        console.log(`Price for ${symbol}:`, quote.regularMarketPrice);
        let price = quote.regularMarketPrice;
        if (quote.currency && (quote.currency === "GBX" || quote.currency === "GBp")) {
          price = price / 100;
}
results.push({ symbol, price });
      } else {
        console.log(`No price for ${symbol}`);
      }
    } catch (e) {
      console.log("Error fetching", symbol, e.message);
    }
  }

  // Store in Supabase price_cache table
  for (const { symbol, price } of results) {
    const { error } = await supabase
      .from("price_cache")
      .upsert([{ symbol, price, last_updated: new Date().toISOString() }], { onConflict: ['symbol'] });
    if (error) {
      console.log(`Failed to save price for ${symbol}:`, error.message);
    } else {
      console.log(`Saved price for ${symbol}: £${price}`);
    }
  }

  console.log("Done!");
  process.exit(0);
}

fetchAndCachePrices();
