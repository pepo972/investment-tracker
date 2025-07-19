import pandas as pd
from supabase import create_client, Client

# === CONFIG ===
SUPABASE_URL = 'https://pkdmxqtvujllymrrbjte.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZG14cXR2dWpsbHltcnJianRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI4NDkzNTksImV4cCI6MjA2ODQyNTM1OX0.WZ4I1-twbfpjCntKWEbzD8_iJzK9uyYgwNfsMOK5EFM'
CSV_FILE = 'Main Portfolio - Trade History 11.07.19-18.07.25.csv'

# Connect to Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Load CSV
df = pd.read_csv(CSV_FILE)

# Convert all NaNs in the DataFrame to None
df = df.where(pd.notnull(df), None)

# Helper: extract ticker and exchange from e.g. "OGZD.LSE"
def split_ticker_exchange(ticker_str):
    if ticker_str and '.' in ticker_str:
        parts = ticker_str.split('.')
        return parts[0], parts[1]
    return ticker_str, ''

# Helper: convert pandas NaN to None for single values
def nan_to_none(x):
    if pd.isna(x):
        return None
    return x

# Step 1: Insert unique stocks
stocks = {}
for _, row in df.iterrows():
    ticker, exchange = split_ticker_exchange(row['Ticker'])
    name = nan_to_none(row['Holding'])
    if not ticker or not name:
        # Skip stocks with missing ticker or name
        continue
    key = (ticker, exchange)
    if key not in stocks:
        stock_data = {
            'ticker': ticker,
            'exchange': exchange,
            'name': name,
            'currency': nan_to_none(row['Holding Currency']),
            # 'sector': nan_to_none(row.get('Sector', None)),  # Uncomment if you add sector
        }
        # Check if already exists in Supabase
        res = supabase.table('stocks').select('id').eq('ticker', ticker).eq('exchange', exchange).execute()
        if not res.data:
            insert_res = supabase.table('stocks').insert(stock_data).execute()
            stock_id = insert_res.data[0]['id']
        else:
            stock_id = res.data[0]['id']
        stocks[key] = stock_id

# Step 2: Insert trades
for _, row in df.iterrows():
    ticker, exchange = split_ticker_exchange(row['Ticker'])
    name = nan_to_none(row['Holding'])
    trade_type = nan_to_none(row['Type'])
    trade_date = nan_to_none(row['Date'])
    quantity = nan_to_none(row['Quantity'])
    if not ticker or not name or not trade_type or not trade_date or not quantity:
        # Skip trades missing required info
        continue
    key = (ticker, exchange)
    stock_id = stocks.get(key)
    if not stock_id:
        continue
    trade_data = {
        'stock_id': stock_id,
        'trade_type': trade_type.upper(),
        'trade_date': pd.to_datetime(trade_date, dayfirst=True).strftime('%Y-%m-%d'),
        'quantity': quantity,
        'price_per_share': nan_to_none(row['Price']),
        'price_currency': nan_to_none(row['Holding Currency']),
        'gbp_value': nan_to_none(row['Value (GBP)']),
        'fx_rate': nan_to_none(row['Exchange Rate']),
        'fee': nan_to_none(row['Fee']),
        'fee_currency': nan_to_none(row['Fee Currency']),
        'local_value': nan_to_none(row['Local Value']),
        'currency_pair': nan_to_none(row['Currency Pair']),
        'notes': '',  # Optional
    }
    supabase.table('trades').insert(trade_data).execute()

print("Import complete! Your trades and stocks are now in Supabase.")