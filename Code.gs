/**
 * Market screener driven by a Google Sheet watchlist.
 *
 * Input tabs (edit these):  US Stocks, India Stocks, Commodities, Crypto
 *   - Symbol:  Yahoo Finance symbol (US: AAPL, India: RELIANCE.NS, metals/oil: GC=F)
 *              or CoinGecko id for crypto (bitcoin, ethereum, ...)
 *   - Name:    free text, shown in results
 *   - Enabled: checkbox. Untick to skip an asset without deleting it.
 *
 * Output tabs (overwritten each run): Results, Alerts, Log
 */

const CONFIG = {
  RANGE: '1y',              // history window for indicators (Yahoo)
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 30,
  RSI_OVERBOUGHT: 70,
  VOLUME_SPIKE: 2,          // today's volume / 20-day average
  NEAR_HIGH_PCT: 3,         // within 3% of 52-week high
  MA_PERIODS: [20, 50, 200], // moving averages watched for breaches and crosses
  MIN_HISTORY: 201,         // need 200 bars for SMA200 plus one prior bar to detect a cross
  DARVAS_CONFIRM_BARS: 3,   // bars a high/low must hold before it forms a box edge
  DARVAS_LOOKBACK: 120,     // how far back to search for the box top
  SHEET_ID_KEY: 'SCREENER_SHEET_ID',
  SEND_EMAIL_DIGEST: true,
};

// Input tabs and their seed lists. Existing tabs are never overwritten, so your edits survive.
const WATCHLISTS = [
  {
    tab: 'US Stocks', market: 'US', assetType: 'Stock', source: 'yahoo',
    seed: [
      ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['GOOGL', 'Alphabet'],
      ['AMZN', 'Amazon'], ['META', 'Meta Platforms'], ['TSLA', 'Tesla'],
    ],
  },
  {
    tab: 'India Stocks', market: 'IN', assetType: 'Stock', source: 'yahoo',
    seed: [
      ['RELIANCE.NS', 'Reliance Industries'], ['TCS.NS', 'Tata Consultancy Services'], ['INFY.NS', 'Infosys'],
      ['HDFCBANK.NS', 'HDFC Bank'], ['ICICIBANK.NS', 'ICICI Bank'], ['SBIN.NS', 'State Bank of India'],
      ['ITC.NS', 'ITC'], ['BHARTIARTL.NS', 'Bharti Airtel'],
    ],
  },
  {
    tab: 'Commodities', market: 'Global', assetType: 'Commodity', source: 'yahoo',
    seed: [
      ['GC=F', 'Gold'], ['SI=F', 'Silver'], ['CL=F', 'Crude Oil (WTI)'], ['BZ=F', 'Brent Crude'],
    ],
  },
  {
    tab: 'Crypto', market: 'Global', assetType: 'Crypto', source: 'coingecko',
    seed: [
      ['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['solana', 'Solana'], ['binancecoin', 'BNB'],
      ['ripple', 'XRP'], ['cardano', 'Cardano'], ['dogecoin', 'Dogecoin'], ['avalanche-2', 'Avalanche'],
    ],
  },
];

const RESULT_HEADERS = [
  'Asset Type', 'Market', 'Symbol', 'Name', 'Currency', 'Price', 'Day %', 'RSI(14)',
  'SMA20', 'SMA50', 'SMA200', '% From 52w High', 'Volume / 20d Avg', 'Darvas Box', 'Trend', 'Signals',
];

// ---------- Entry points ----------

function runScreener() {
  const ss = getOutputSheet();
  ensureWatchlistTabs(ss);

  const errors = [];
  const results = [];
  for (const list of WATCHLISTS) {
    for (const item of readWatchlist(ss, list)) {
      try {
        results.push(analyzeAsset(item, list));
      } catch (e) {
        errors.push([new Date(), `${list.tab} / ${item.symbol}: ${e.message}`]);
      }
      Utilities.sleep(list.source === 'coingecko' ? 6000 : 300); // CoinGecko free tier allows only a few calls per minute
    }
  }

  const alerts = results
    .filter(r => r.signals.length)
    .sort((a, b) => b.signals.length - a.signals.length);

  writeTab(ss, 'Results', RESULT_HEADERS, results.map(resultRow));
  writeTab(ss, 'Alerts', RESULT_HEADERS, alerts.map(resultRow));
  writeTab(ss, 'Log', ['Time', 'Message'], errors);

  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (CONFIG.SEND_EMAIL_DIGEST) sendDigest(results, alerts, errors);

  Logger.log(`Done: ${results.length} assets analysed, ${alerts.length} alerts, ${errors.length} errors`);
  return ss.getUrl();
}

/** Run once: creates the daily 7am trigger (timezone set in appsscript.json). */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runScreener')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runScreener').timeBased().everyDays(1).atHour(7).create();
  Logger.log('Daily trigger created.');
}

// ---------- Watchlist (input tabs) ----------

/** Creates any missing input tabs with the seed list. Existing tabs are left alone. */
function ensureWatchlistTabs(ss) {
  for (const list of WATCHLISTS) {
    if (ss.getSheetByName(list.tab)) continue;

    const sh = ss.insertSheet(list.tab);
    const rows = list.seed.map(([symbol, name]) => [symbol, name, true]);
    sh.getRange(1, 1, 1, 3).setValues([['Symbol', 'Name', 'Enabled']]).setFontWeight('bold');
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
    sh.getRange(2, 3, 500, 1).insertCheckboxes(); // checkboxes for future rows too
    sh.getRange(1, 5).setValue(
      list.source === 'coingecko'
        ? 'Symbol = CoinGecko id (e.g. bitcoin). Find it in the coin URL on coingecko.com.'
        : 'Symbol = Yahoo Finance symbol. India needs .NS (or .BO), e.g. TCS.NS. Commodities: GC=F, SI=F, CL=F, BZ=F.'
    ).setFontStyle('italic');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, 3);
  }
}

/** Returns the enabled rows of an input tab as [{symbol, name}]. Blank rows are skipped. */
function readWatchlist(ss, list) {
  const sh = ss.getSheetByName(list.tab);
  if (!sh || sh.getLastRow() < 2) return [];

  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(([symbol, , enabled]) => String(symbol).trim() && enabled !== false)
    .map(([symbol, name]) => ({ symbol: String(symbol).trim(), name: String(name).trim() }));
}

// ---------- Analysis ----------

function analyzeAsset(item, list) {
  const h = list.source === 'coingecko' ? fetchCoinGecko(item.symbol) : fetchYahoo(item.symbol);
  const c = h.closes;
  const v = h.volumes;
  const price = h.price;
  const prevPrice = c[c.length - 2];
  const prev = c.slice(0, -1); // same series without today's bar

  const [p20, p50, p200] = CONFIG.MA_PERIODS;
  const sma20 = sma(c, p20);
  const sma50 = sma(c, p50);
  const sma200 = sma(c, p200);
  const prevSma20 = sma(prev, p20);
  const prevSma50 = sma(prev, p50);
  const prevSma200 = sma(prev, p200);

  const r = rsi(c, CONFIG.RSI_PERIOD);
  const high52 = Math.max(...c);
  const avgVol20 = sma(v, 20);
  const volRatio = avgVol20 ? v[v.length - 1] / avgVol20 : null;
  const dayPct = h.prevClose ? (price - h.prevClose) / h.prevClose * 100 : null;
  const fromHigh = (price - high52) / high52 * 100;

  // Breaches: price moved from one side of an average to the other since the previous bar
  const signals = [];
  const checkBreach = (n, ma, prevMa) => {
    if (prevPrice <= prevMa && price > ma) signals.push(`BUY: crossed above ${n}DMA`);
    if (prevPrice >= prevMa && price < ma) signals.push(`SELL: crossed below ${n}DMA`);
  };
  checkBreach(p20, sma20, prevSma20);
  checkBreach(p50, sma50, prevSma50);
  checkBreach(p200, sma200, prevSma200);

  // Crosses between averages
  if (prevSma20 <= prevSma50 && sma20 > sma50) signals.push(`BUY: ${p20}/${p50} golden cross`);
  if (prevSma20 >= prevSma50 && sma20 < sma50) signals.push(`SELL: ${p20}/${p50} death cross`);
  if (prevSma50 <= prevSma200 && sma50 > sma200) signals.push(`BUY: ${p50}/${p200} golden cross`);
  if (prevSma50 >= prevSma200 && sma50 < sma200) signals.push(`SELL: ${p50}/${p200} death cross`);

  // Darvas box: breakout/breakdown is a close beyond the box edge that was set before the previous bar
  const boxNow = darvasBox(h.highs.slice(0, -1), h.lows.slice(0, -1));
  const boxPrev = darvasBox(h.highs.slice(0, -2), h.lows.slice(0, -2));
  if (boxNow && boxPrev) {
    if (price > boxNow.top && prevPrice <= boxPrev.top) signals.push(`BUY: broke above Darvas box top ${round(boxNow.top, 2)}`);
    if (price < boxNow.bottom && prevPrice >= boxPrev.bottom) signals.push(`SELL: broke below Darvas box bottom ${round(boxNow.bottom, 2)}`);
  }

  // Momentum and context
  if (r != null && r < CONFIG.RSI_OVERSOLD) signals.push(`Oversold (RSI ${r.toFixed(0)})`);
  if (r != null && r > CONFIG.RSI_OVERBOUGHT) signals.push(`Overbought (RSI ${r.toFixed(0)})`);
  if (volRatio && volRatio >= CONFIG.VOLUME_SPIKE) signals.push(`Volume spike ${volRatio.toFixed(1)}x`);
  if (fromHigh > -CONFIG.NEAR_HIGH_PCT) signals.push('Near 52w high');

  return {
    assetType: list.assetType, market: list.market, symbol: item.symbol, name: item.name,
    currency: h.currency, price, dayPct, rsi: r, sma20, sma50, sma200, fromHigh, volRatio,
    darvas: boxNow, trend: trendState(price, sma20, sma50, sma200), signals,
  };
}

/** Bullish stack: price > 20 > 50 > 200. Bearish stack is the reverse. Anything else is mixed. */
function trendState(price, s20, s50, s200) {
  if (price > s20 && s20 > s50 && s50 > s200) return 'Bullish stack';
  if (price < s20 && s20 < s50 && s50 < s200) return 'Bearish stack';
  return 'Mixed';
}

function resultRow(r) {
  return [
    r.assetType, r.market, r.symbol, r.name, r.currency, round(r.price, 2), round(r.dayPct, 2),
    round(r.rsi, 1), round(r.sma20, 2), round(r.sma50, 2), round(r.sma200, 2), round(r.fromHigh, 2),
    round(r.volRatio, 2), darvasText(r.darvas), r.trend, r.signals.join('; '),
  ];
}

// Both sources return the same shape: {price, prevClose, currency, closes, volumes}

function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${CONFIG.RANGE}&interval=1d`;
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (res.getResponseCode() !== 200) throw new Error(`Yahoo HTTP ${res.getResponseCode()}`);

  const body = JSON.parse(res.getContentText());
  const result = body.chart && body.chart.result && body.chart.result[0];
  if (!result) throw new Error('no data returned (check symbol)');

  const q = result.indicators.quote[0];
  const closes = [];
  const volumes = [];
  const highs = [];
  const lows = [];
  q.close.forEach((close, i) => {
    if (close != null) {
      closes.push(close);
      volumes.push(q.volume[i] || 0);
      highs.push(q.high[i] != null ? q.high[i] : close);
      lows.push(q.low[i] != null ? q.low[i] : close);
    }
  });
  if (closes.length < CONFIG.MIN_HISTORY) throw new Error(`only ${closes.length} bars, need ${CONFIG.MIN_HISTORY}`);

  return {
    price: result.meta.regularMarketPrice,
    prevClose: result.meta.chartPreviousClose,
    currency: result.meta.currency,
    closes,
    volumes,
    highs,
    lows,
  };
}

function fetchCoinGecko(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`;
  const res = fetchWithRetry(url, 4);
  if (res.getResponseCode() !== 200) throw new Error(`CoinGecko HTTP ${res.getResponseCode()} (check id)`);

  const body = JSON.parse(res.getContentText());
  const closes = body.prices.map(p => p[1]);
  const volumes = body.total_volumes.map(p => p[1]);
  if (closes.length < CONFIG.MIN_HISTORY) throw new Error(`only ${closes.length} bars, need ${CONFIG.MIN_HISTORY}`);

  return {
    price: closes[closes.length - 1],
    prevClose: closes[closes.length - 2],
    currency: 'USD',
    closes,
    volumes,
    // CoinGecko's free daily endpoint has no high/low, so the box uses closes (approximate)
    highs: closes,
    lows: closes,
  };
}

/**
 * Fetches a URL, retrying on HTTP 429 (rate limit) with exponential backoff.
 * Uses the Retry-After header when the server sends one.
 */
function fetchWithRetry(url, maxRetries) {
  let res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  for (let attempt = 1; res.getResponseCode() === 429 && attempt <= maxRetries; attempt++) {
    const retryAfter = Number(res.getHeaders()['Retry-After'] || res.getHeaders()['retry-after']);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 10000 * Math.pow(2, attempt - 1); // 10s, 20s, 40s, 80s
    Logger.log(`429 from ${url}, waiting ${waitMs / 1000}s (attempt ${attempt})`);
    Utilities.sleep(waitMs);
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  }
  return res;
}

// ---------- Indicators ----------

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// Wilder's RSI
function rsi(closes, n) {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Darvas box from daily highs and lows. The top is the most recent high that the next
 * DARVAS_CONFIRM_BARS bars did not exceed. The bottom is the lowest low since that top.
 * Returns {top, bottom} or null if no confirmed top exists in the lookback window.
 */
function darvasBox(highs, lows) {
  const n = CONFIG.DARVAS_CONFIRM_BARS;
  const m = highs.length;
  const start = Math.max(0, m - CONFIG.DARVAS_LOOKBACK);

  for (let t = m - 1 - n; t >= start; t--) {
    let confirmed = true;
    for (let k = 1; k <= n; k++) {
      if (highs[t + k] > highs[t]) { confirmed = false; break; }
    }
    if (!confirmed) continue;

    let bottom = Infinity;
    for (let j = t + 1; j < m; j++) bottom = Math.min(bottom, lows[j]);
    return { top: highs[t], bottom };
  }
  return null;
}

function darvasText(box) {
  return box ? `${round(box.bottom, 2)} - ${round(box.top, 2)}` : '';
}

// ---------- Output ----------

function getOutputSheet() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CONFIG.SHEET_ID_KEY);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      Logger.log('Stored sheet not accessible, creating a new one.');
    }
  }
  const ss = SpreadsheetApp.create('Market Screener');
  props.setProperty(CONFIG.SHEET_ID_KEY, ss.getId());
  Logger.log(`Created sheet: ${ss.getUrl()}`);
  return ss;
}

/** Overwrites an output tab. Only use this on Results, Alerts and Log, never on input tabs. */
function writeTab(ss, name, headers, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  const data = [headers, ...rows];
  sh.getRange(1, 1, data.length, headers.length).setValues(data);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}

// ---------- Email ----------

function sendDigest(results, alerts, errors) {
  const lines = [`Alerts: ${alerts.length} of ${results.length} assets flagged.`, ''];
  for (const type of ['Stock', 'Commodity', 'Crypto']) {
    const group = alerts.filter(r => r.assetType === type);
    if (!group.length) continue;
    lines.push(`${type}s:`);
    group.forEach(r => lines.push(`  [${r.market}] ${r.symbol} (${r.name}) ${round(r.price, 2)} ${r.currency} - ${r.signals.join('; ')}`));
    lines.push('');
  }
  if (errors.length) lines.push(`Errors (${errors.length}): see the Log tab.`);

  const to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, `Market screener: ${alerts.length} alerts`, lines.join('\n'));
}

// ---------- Helpers ----------

function round(x, d) {
  if (x == null || Number.isNaN(x)) return '';
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}
