# Market Screener (Apps Script)

**Website with download and setup steps: https://rahuling.github.io/market-screener/**

Screens a watchlist of stocks (US and India), commodities (gold, silver, oil) and crypto. The watchlist lives in a Google Sheet, so you add and remove assets there without touching code. Results go to the same sheet, and you get a daily email of alerts.

## The sheet

After the first run, the spreadsheet "Market Screener" has these tabs:

| Tab | Who writes it | Purpose |
|---|---|---|
| **US Stocks** | you | Watchlist |
| **India Stocks** | you | Watchlist |
| **Commodities** | you | Watchlist |
| **Crypto** | you | Watchlist |
| **Results** | script (overwritten each run) | Every asset with price, RSI, moving averages, 52-week position, volume, signals |
| **Alerts** | script (overwritten each run) | Only assets with at least one signal, most signals first |
| **Log** | script (overwritten each run) | Fetch errors, such as a bad symbol |

Each watchlist tab has three columns:

- **Symbol**: the ticker the data source understands
- **Name**: any label, shown in the results
- **Enabled**: a checkbox. Untick it to pause an asset without deleting it.

### Adding an asset
Add a row with a symbol, a name, and tick Enabled. The next run picks it up.

### Removing an asset
Delete the row, or untick Enabled to keep it for later.

### Symbol formats
- **US stocks**: `AAPL`, `NVDA`, and so on
- **India (NSE)**: add `.NS`, for example `TCS.NS`. BSE tickers use `.BO`.
- **Commodities**: `GC=F` gold, `SI=F` silver, `CL=F` WTI crude, `BZ=F` Brent. Other futures symbols work the same way if you look them up on Yahoo Finance.
- **Crypto**: the CoinGecko id, which is the lowercase name in the coin's URL, for example `bitcoin`, `ethereum`, `avalanche-2`. Symbols like `BTC` won't work.

The first run seeds each tab with a standard list: 7 US stocks, 8 Indian stocks, 4 commodities, and 8 cryptocurrencies. Existing tabs are never overwritten, so your edits survive later runs.

## What the screener flags

**Events (these go to the Alerts tab and the email):**
- **BUY / SELL: crossed above / below 20, 50 or 200-day average.** Price moved from one side of the average to the other since the previous close.
- **BUY / SELL: golden / death cross.** The 20 and 50-day, or the 50 and 200-day, averages crossed.
- **BUY / SELL: broke above / below the Darvas box.** The close moved beyond the box edge.
- Oversold (RSI below 30) or overbought (RSI above 70)
- Volume at least 2x the 20-day average
- Within 3% of the 52-week high

**State (shown on Results, not alerted on):**
- **Trend:** *Bullish stack* when price > 20 > 50 > 200-day average. *Bearish stack* is the reverse. Otherwise *Mixed*.
- **Darvas box:** the lower and upper edges of the most recent box, as `bottom - top`.

Thresholds and periods are in the `CONFIG` block at the top of `Code.gs`. Check that `MIN_HISTORY` is 201, since the 200-day average needs that much data. Assets with less history are skipped and logged.

**How the Darvas box is built:** the top is the most recent high that the next 3 bars did not exceed. The bottom is the lowest low since that top. Yahoo provides highs and lows, so stocks, commodities, and metals use them directly. CoinGecko's free endpoint only gives closes, so the crypto box is approximate.

**Note on the signals:** they fire on the day of the cross, not on every day the price stays above or below an average. The screen runs once a day after the close, so a cross during the session is only caught on the next run.

## Setup

1. Go to https://script.google.com and create a **New project**.
2. Paste `Code.gs` into the default file. Then open **Project Settings → Show "appsscript.json"** and paste in `appsscript.json`.
3. Run `runScreener` once and approve the permissions. This creates the "Market Screener" spreadsheet and the four watchlist tabs, then runs the screen and emails you the results.
4. Run `setupDailyTrigger` once. It schedules the screen for 7am Asia/Kolkata, after the Indian close and after the previous US close.

To use `clasp` instead: `clasp create --type standalone --title "Market Screener"`, then `clasp push`.

## Caveats

- **Yahoo Finance** is an unofficial endpoint. It works without a key but can change or rate-limit. Failures show up in the Log tab.
- **CoinGecko's free tier** is rate-limited. The script pauses 6 seconds between coins and retries HTTP 429 responses with backoff (10s, 20s, 40s, 80s). Roughly 8 coins finish in about a minute. Keep the crypto list under about 20 coins, or the run may approach Apps Script's 6-minute limit.
- Indicators use daily closes, so "52-week high" means the highest close in the past year, not the intraday high.
- This is a screening aid for research and learning. It is not investment advice.
