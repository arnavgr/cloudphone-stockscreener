export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Route: Ticker Search Engine (Global Equities, ETFs, Crypto, International)
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return json([]);

      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
          headers: { 'User-Agent': UA }
        });
        const data = await res.json();
        const results = (data.quotes || [])
          .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'CRYPTOCURRENCY')
          .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol }));
        return json(results);
      } catch (e) {
        return json([]);
      }
    }

    // API Route: Price + 1Y chart + Live daily change (Yahoo)
    if (url.pathname === '/api/stock') {
      const cleanSymbol = sanitizeSymbol(url.searchParams.get('s'));
      if (!cleanSymbol) return json({ error: 'No valid symbol provided' }, 400);

      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const payload = await fetchChartData(cleanSymbol);
      const resp = json(payload);
      resp.headers.set('Cache-Control', 'public, max-age=30');
      if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    // API Route: Deep fundamentals - Finnhub (Cached in KV for 24h)
    if (url.pathname === '/api/fundamentals') {
      const cleanSymbol = sanitizeSymbol(url.searchParams.get('s'));
      if (!cleanSymbol) return json({ error: 'No valid symbol provided' }, 400);

      if (cleanSymbol.includes('-USD') || cleanSymbol.includes('-EUR')) {
        return json({ available: false, isCrypto: true });
      }

      const kv = env.FUNDAMENTALS_KV;
      const kvKey = 'fundv3:' + cleanSymbol;

      if (kv) {
        try {
          const cachedStr = await kv.get(kvKey);
          if (cachedStr) return json(JSON.parse(cachedStr));
        } catch (e) {
          console.error('KV read error: ', e);
        }
      }

      const data = await fetchFundamentals(cleanSymbol, env);
      const payload = { symbol: cleanSymbol, ...data };

      if (kv && data.available) {
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(kv.put(kvKey, JSON.stringify(payload), { expirationTtl: 86400 }).catch(e => console.error('KV write error: ', e)));
        }
      }

      return json(payload);
    }

    return new Response(getAppHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// --- Shared config ---
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- Helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function sanitizeSymbol(raw) {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().trim().replace(/[^A-Z0-9.\-^]/g, '').slice(0, 20);
  return cleaned || null;
}

function formatLargeNum(num) {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  const sign = num < 0 ? '-' : '';
  num = Math.abs(num);
  if (num >= 1e12) return sign + (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return sign + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return sign + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return sign + (num / 1e3).toFixed(2) + 'K';
  return sign + num.toString();
}

function fmtNum(val, decimals = 2) {
  return (val === null || val === undefined || isNaN(val)) ? 'N/A' : val.toFixed(decimals);
}

function fmtPct(fraction, decimals = 2) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return 'N/A';
  let pct = fraction * 100;
  if (Object.is(pct, -0)) pct = 0; // Prevent negative zero
  const sign = pct > 0 ? '+' : '';
  return sign + pct.toFixed(decimals) + '%';
}

function fmtDividendYield(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return 'N/A';
  let pct = fraction * 100;
  if (Math.abs(pct) > 25) pct = fraction;
  if (Object.is(pct, -0)) pct = 0; // Prevent negative zero
  return pct.toFixed(2) + '%';
}

// --- Chart + price data ---
async function fetchChartData(cleanSymbol) {
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?range=1y&interval=1d`;
  const liveUrl  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?range=1d&interval=5m`;

  let price = 0, name = cleanSymbol, closes = [], timestamps = [];
  let volume = 0, marketCap = 0;
  let startDateStr = 'N/A', endDateStr = 'N/A', yearHigh = 'N/A', yearLow = 'N/A';
  let livePrevClose = 0;

  const [chartRes, liveRes] = await Promise.all([
    fetch(chartUrl, { headers: { 'User-Agent': UA } }).catch(() => null),
    fetch(liveUrl,  { headers: { 'User-Agent': UA } }).catch(() => null)
  ]);

  if (chartRes && chartRes.ok) {
    try {
      const chartJson = await chartRes.json();
      const result = chartJson && chartJson.chart && chartJson.chart.result && chartJson.chart.result[0];
      if (result) {
        const meta = result.meta || {};
        const quoteIndicator = result.indicators && result.indicators.quote && result.indicators.quote[0];
        const validPoints = [];

        if (result.timestamp && quoteIndicator && quoteIndicator.close) {
          result.timestamp.forEach((t, i) => {
            const c = quoteIndicator.close[i];
            if (typeof c === 'number' && !isNaN(c) && isFinite(c)) {
              validPoints.push({ time: t, close: c });
            }
          });
        }

        closes = validPoints.map(p => p.close);
        timestamps = validPoints.map(p => p.time);

        price = meta.regularMarketPrice || price;
        volume = meta.regularMarketVolume || volume;
        name = meta.shortName || meta.longName || cleanSymbol;
        if (meta.marketCap) marketCap = meta.marketCap;

        if (closes.length > 0) {
          yearHigh = Math.max(...closes).toFixed(2);
          yearLow  = Math.min(...closes).toFixed(2);
          startDateStr = new Date(validPoints[0].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
          endDateStr   = new Date(validPoints[validPoints.length - 1].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        }
      }
    } catch (e) {
      console.error('1Y chart parse error: ', e);
    }
  }

  let livePrice = 0;
  if (liveRes && liveRes.ok) {
    try {
      const liveJson = await liveRes.json();
      const result = liveJson && liveJson.chart && liveJson.chart.result && liveJson.chart.result[0];
      if (result) {
        const meta = result.meta || {};
        livePrice    = (typeof meta.regularMarketPrice === 'number') ? meta.regularMarketPrice : 0;
        livePrevClose = (typeof meta.previousClose === 'number') ? meta.previousClose
                       : (typeof meta.chartPreviousClose === 'number') ? meta.chartPreviousClose : 0;
        if (livePrice) price = livePrice; 
      }
    } catch (e) {
      console.error('1D live parse error: ', e);
    }
  }

  let change = 0, changePercent = 0;
  if (livePrevClose) {
    change = price - livePrevClose;
    changePercent = livePrevClose ? (change / livePrevClose) * 100 : 0;
  } else if (closes.length >= 2) {
    const lastClose = closes[closes.length - 1];
    const prevDay   = closes[closes.length - 2];
    change = lastClose - prevDay;
    changePercent = prevDay ? (change / prevDay) * 100 : 0;
  }

  return {
    symbol: cleanSymbol,
    name: (name && name.length > 25) ? (name.substring(0, 22) + '...') : (name || cleanSymbol),
    price: price ? price.toFixed(2) : '0.00',
    change: change ? change.toFixed(2) : '0.00',
    changePercent: changePercent ? changePercent.toFixed(2) : '0.00',
    marketCap: marketCap ? formatLargeNum(marketCap) : 'N/A',
    volume: volume ? formatLargeNum(volume) : 'N/A',
    closes,
    timestamps,
    startDate: startDateStr,
    endDate: endDateStr,
    yearHigh,
    yearLow
  };
}

// --- Fundamentals (Finnhub Migration) ---
function mVal(metric, ...candidates) {
  for (const key of candidates) {
    const v = metric[key];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

// Safe percentage extractor to prevent null/100 = 0% bugs
function pctVal(metric, ...keys) {
  const v = mVal(metric, ...keys);
  if (v === null || v === undefined) return null;
  return v / 100;
}

async function fetchFundamentals(cleanSymbol, env) {
  const apiKey = env && env.FINNHUB_API_KEY;
  if (!apiKey) return { available: false, reason: 'missing_api_key' };

  const sym = encodeURIComponent(cleanSymbol);
  const token = encodeURIComponent(apiKey);

  try {
    const [profileRes, metricRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${token}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${token}`)
    ]);

    if (!profileRes.ok || !metricRes.ok) return { available: false };

    const profile = await profileRes.json();
    const metricBody = await metricRes.json();
    const metric = (metricBody && metricBody.metric) || {};

    if (!profile || !profile.name) return { available: false };

    let recommendation = null;
    try {
      const recRes = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${sym}&token=${token}`);
      if (recRes.ok) {
        const recArr = await recRes.json();
        if (Array.isArray(recArr) && recArr.length > 0) recommendation = recArr[0];
      }
    } catch (e) {
      console.error('Analyst data fetch error: ', e);
    }

    const marketCapM = typeof profile.marketCapitalization === 'number' ? profile.marketCapitalization : null;
    const sharesOutM = typeof profile.shareOutstanding === 'number' ? profile.shareOutstanding : null;

    return {
      available: true,
      valuation: {
        marketCap: marketCapM !== null ? formatLargeNum(marketCapM * 1e6) : 'N/A',
        peTrailing: fmtNum(mVal(metric, 'peTTM', 'peNormalizedAnnual')),
        peForward: fmtNum(mVal(metric, 'forwardPE')),
        priceToBook: fmtNum(mVal(metric, 'pbAnnual', 'pbQuarterly')),
        priceToSales: fmtNum(mVal(metric, 'psTTM', 'psAnnual'))
      },
      perShare: {
        eps: fmtNum(mVal(metric, 'epsTTM', 'epsBasicExclExtraItemsTTM')),
        bookValue: fmtNum(mVal(metric, 'bookValuePerShareQuarterly', 'bookValuePerShareAnnual')),
        revenuePerShare: fmtNum(mVal(metric, 'revenuePerShareTTM'))
      },
      profitability: {
        profitMargin: fmtPct(pctVal(metric, 'netProfitMarginTTM')),
        operatingMargin: fmtPct(pctVal(metric, 'operatingMarginTTM')),
        grossMargin: fmtPct(pctVal(metric, 'grossMarginTTM')),
        roe: fmtPct(pctVal(metric, 'roeTTM')),
        roa: fmtPct(pctVal(metric, 'roaTTM'))
      },
      growth: {
        revenueGrowth: fmtPct(pctVal(metric, 'revenueGrowthTTMYoy')),
        earningsGrowth: fmtPct(pctVal(metric, 'epsGrowthTTMYoy'))
      },
      dividends: {
        yield: fmtDividendYield(pctVal(metric, 'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM')),
        perShare: fmtNum(mVal(metric, 'dividendPerShareAnnual'))
      },
      financialHealth: {
        debtToEquity: fmtNum(mVal(metric, 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual')),
        currentRatio: fmtNum(mVal(metric, 'currentRatioQuarterly', 'currentRatioAnnual')),
        quickRatio: fmtNum(mVal(metric, 'quickRatioQuarterly', 'quickRatioAnnual'))
      },
      trading: {
        beta: fmtNum(mVal(metric, 'beta')),
        fiftyTwoWeekHigh: fmtNum(mVal(metric, '52WeekHigh')),
        fiftyTwoWeekLow: fmtNum(mVal(metric, '52WeekLow')),
        sharesOutstanding: sharesOutM !== null ? formatLargeNum(sharesOutM * 1e6) : 'N/A'
      },
      analyst: {
        strongBuy: recommendation ? String(recommendation.strongBuy) : 'N/A',
        buy: recommendation ? String(recommendation.buy) : 'N/A',
        hold: recommendation ? String(recommendation.hold) : 'N/A',
        sell: recommendation ? String(recommendation.sell) : 'N/A',
        strongSell: recommendation ? String(recommendation.strongSell) : 'N/A'
      },
      company: {
        sector: profile.finnhubIndustry || 'N/A',
        exchange: profile.exchange || 'N/A',
        country: profile.country || 'N/A',
        ipo: profile.ipo || 'N/A'
      }
    };
  } catch (e) {
    console.error('Fundamentals fetch error: ', e);
    return { available: false };
  }
}

// --- Frame UI Matrix Layout ---
function getAppHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>cloudphone stocktracker</title>
<style>
  :root {
    --bg: #000000; --card: #111111; --border: #222222;
    --text: #ffffff; --muted: #888888;
    --up: #00ff00; --down: #ff0000; --accent: #00ff00;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: monospace; padding-bottom: 40px; font-size: 4.2vw; }
  header { background: var(--card); padding: 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  h1 { font-size: 4vw; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; text-transform: uppercase; letter-spacing: 0.5px; }
  .logo-side { display: flex; align-items: center; gap: 6px; }
  .logo { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
  #alpha-score { font-size: 3.4vw; color: var(--accent); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; background: var(--bg); }
  .search-container { position: relative; }
  input { width: 100%; padding: 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 4.2vw; font-family: monospace; outline: none; }
  input:focus { border-color: var(--accent); }
  #search-results { display: none; position: absolute; top: 42px; left: 0; right: 0; background: var(--card); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; z-index: 20; }
  #search-results.show { display: block; }
  .res-item { padding: 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .res-item:active { background: var(--bg); }
  .res-sym { font-weight: 700; color: var(--accent); font-size: 4.2vw; }
  .res-name { font-size: 3.4vw; color: var(--muted); margin-top: 2px; }

  .card { background: var(--card); margin: 8px; padding: 12px; border-radius: 4px; border: 1px solid var(--border); }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
  .sym { font-size: 4.6vw; height: auto; font-weight: 700; color: #fff; }
  .name { font-size: 3.4vw; color: var(--muted); margin-top: 2px; word-break: break-all; }
  .price { text-align: right; }
  .p-val { font-size: 4.6vw; font-weight: 700; }
  .p-change { font-size: 3.6vw; font-weight: 600; margin-top: 2px; }
  .up { color: var(--up); } .down { color: var(--down); }
  
  .yield-row { display: flex; justify-content: space-between; background: var(--bg); padding: 6px 8px; border-radius: 3px; border: 1px solid var(--border); font-size: 3.6vw; margin-top: 4px; margin-bottom: 2px; }
  .yield-lbl { color: var(--muted); text-transform: uppercase; font-size: 3.2vw; }
  .yield-val { font-weight: 700; }

  .card-links { display: flex; gap: 6px; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .btn { text-align: center; padding: 8px; border-radius: 4px; text-decoration: none; font-size: 3.6vw; font-weight: 600; border: 1px solid var(--border); color: var(--text); background: var(--bg); flex: 1; }
  .btn-primary { border-color: var(--accent); color: var(--accent); }

  .remove-btn { color: var(--down); background: transparent; border: none; font-size: 3.4vw; margin-top: 8px; cursor: pointer; padding: 0; text-transform: uppercase; width: 100%; text-align: center; display: block; }

  #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.98); z-index: 100; padding: 10px; overflow-y: auto; -webkit-overflow-scrolling: touch; outline: none; }
  #modal.show { display: block; }
  .modal-content { background: var(--card); border-radius: 4px; padding: 12px; border: 1px solid var(--border); }
  .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .modal-header h2 { font-size: 4vw; text-transform: uppercase; }
  .close-btn { background: var(--bg); border: 1px solid var(--border); color: var(--text); width: 26px; height: 26px; font-size: 13px; cursor: pointer; flex-shrink: 0; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .stat { background: var(--bg); padding: 6px; border-radius: 4px; border: 1px solid var(--border); }
  .stat-lbl { font-size: 3vw; color: var(--muted); text-transform: uppercase; }
  .stat-val { font-size: 3.8vw; font-weight: 600; margin-top: 2px; word-break: break-all; }
  .stat-val.na { color: var(--muted); font-weight: 400; }
  .stat-val.pos { color: var(--up); }
  .stat-val.neg { color: var(--down); }

  .fund-section-title { font-size: 3.8vw; color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  .fund-section-title:first-of-type { margin-top: 0; }
  .info-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 3.8vw; }
  .info-row:last-child { border-bottom: none; }
  .info-row .stat-lbl { font-size: 3.4vw; }
  .info-row .stat-val { font-size: 3.8vw; text-align: right; }
  .fund-unavailable { text-align: center; padding: 16px 8px; color: var(--muted); font-size: 3.6vw; border: 1px dashed var(--border); border-radius: 4px; margin-top: 8px; line-height: 1.5; }
  
  #chart-container { margin: 10px 0; position: relative; width: 100%; }
  .chart-svg { width: 100%; height: auto; display: block; }
  .empty { text-align: center; padding: 20px; color: var(--muted); font-size: 3.6vw; }
  .timeline-label { display: flex; justify-content: space-between; margin-top: -2px; margin-bottom: 12px; font-size: 3vw; color: var(--muted); }

  .tv-grid { stroke: #1d1d1d; stroke-width: 0.6; }
  .tv-grid-month { stroke: #1a1a1a; stroke-width: 0.6; opacity: 0.6; }
  .tv-axis { stroke: #2a2a2a; stroke-width: 0.8; }
  .tv-price-lbl { fill: #777; font-size: 10px; font-family: monospace; }
  .tv-month-lbl { fill: #666; font-size: 9px; font-family: monospace; }
  .tv-last-line { stroke-width: 0.7; stroke-dasharray: 2,2; opacity: 0.55; }
  .tv-tag-txt { font-size: 11px; font-weight: 700; font-family: monospace; }
</style>
</head>
<body>

<header>
  <h1>
    <div class="logo-side"><div class="logo"></div> cloudphone stocktracker</div>
    <div id="alpha-score">YIELD: --</div>
  </h1>
  <div class="search-container">
    <input type="text" id="search-input" placeholder="Search Ticker..." autocomplete="off">
    <div id="search-results"></div>
  </div>
</header>

<div id="watchlist"></div>

<div id="modal" tabindex="0">
  <div class="modal-content">
    <div class="modal-header">
      <h2 id="modal-title">Historical Analytics</h2>
      <button class="close-btn" onclick="closeModal()">✕</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
  // Structured schema array mapping for Equal-Weight Ghost Portfolio entries
  let portfolio = [];

  try {
    const stored = localStorage.getItem('tracked_portfolio_v1');
    if (stored) {
      portfolio = JSON.parse(stored);
    } else {
      // Configuration fallback defaults: AAPL, SPCX, BTC-USD
      portfolio = [
        { symbol: 'AAPL', entryPrice: null, date: Date.now() },
        { symbol: 'SPCX', entryPrice: null, date: Date.now() },
        { symbol: 'BTC-USD', entryPrice: null, date: Date.now() }
      ];
      savePortfolio();
    }
  } catch(e) {
    portfolio = [{ symbol: 'AAPL', entryPrice: null, date: Date.now() }];
  }

  function savePortfolio() {
    localStorage.setItem('tracked_portfolio_v1', JSON.stringify(portfolio));
  }

  function updateUrl() {
    const symList = portfolio.map(p => p.symbol).join(',');
    const newUrl = window.location.pathname + '?s=' + symList;
    window.history.replaceState({}, '', newUrl);
  }

  let searchTimeout;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) { document.getElementById('search-results').classList.remove('show'); return; }
    searchTimeout = setTimeout(() => doSearch(q), 300);
  });

  async function doSearch(q) {
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      const resultsDiv = document.getElementById('search-results');
      if (data.length === 0) { resultsDiv.classList.remove('show'); return; }

      resultsDiv.innerHTML = data.map(r => \`
        <div class="res-item" onclick="addStock('\${r.symbol}')">
          <div class="res-sym">\${r.symbol}</div>
          <div class="res-name">\${r.name}</div>
        </div>
      \`).join('');
      resultsDiv.classList.add('show');
    } catch(e) { console.error(e); }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      document.getElementById('search-results').classList.remove('show');
    }
  });

  function addStock(symbol) {
    symbol = symbol.toUpperCase();
    if (!portfolio.some(p => p.symbol === symbol)) {
      portfolio.push({ symbol: symbol, entryPrice: null, date: Date.now() });
      savePortfolio();
    }
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').classList.remove('show');
    updateUrl();
    renderWatchlist();
  }

  function removeStock(symbol) {
    portfolio = portfolio.filter(p => p.symbol !== symbol);
    savePortfolio();
    updateUrl();
    renderWatchlist();
  }

  // Toggle transaction baseline parameters (Lock Entry Price Base)
  function toggleTrackYield(symbol, currentPrice) {
    const idx = portfolio.findIndex(p => p.symbol === symbol);
    if (idx !== -1) {
      if (portfolio[idx].entryPrice === null) {
        const parsedPrice = parseFloat(currentPrice);
        // Prevent tracking if price is invalid or 0
        if (!isNaN(parsedPrice) && parsedPrice > 0) {
          portfolio[idx].entryPrice = parsedPrice;
          portfolio[idx].date = Date.now();
        } else {
          return; 
        }
      } else {
        portfolio[idx].entryPrice = null;
      }
      savePortfolio();
      renderWatchlist();
    }
  }

  // Race condition tracker for rendering
  let renderRequestId = 0;

  async function renderWatchlist() {
    const myRequestId = ++renderRequestId;
    const container = document.getElementById('watchlist');
    
    if (portfolio.length === 0) {
      container.innerHTML = '<div class="empty">Watchlist empty. Search and build tracking elements.</div>';
      document.getElementById('alpha-score').innerText = 'YIELD: --';
      return;
    }

    container.innerHTML = '<div class="empty">SYNCING MARKET MATRIX...</div>';
    
    let totalYieldSum = 0;
    let validYieldCount = 0;

    const html = await Promise.all(portfolio.map(async item => {
      try {
        const res = await fetch('/api/stock?s=' + item.symbol);
        if (!res.ok) throw new Error();
        const d = await res.json();
        
        // Parse numbers cleanly to prevent string comparison bugs
        const changeNum = parseFloat(d.change) || 0;
        const upDown = changeNum >= 0 ? 'up' : 'down';
        const arrow = changeNum >= 0 ? '▲' : '▼';
        
        // Dynamic generation of individual card baseline yields
        let yieldMarkup = '';
        if (item.entryPrice !== null && item.entryPrice > 0) {
          const currentPriceNum = parseFloat(d.price);
          
          // Calculate yield only if the current price is valid
          if (!isNaN(currentPriceNum) && isFinite(currentPriceNum)) {
            const itemYield = ((currentPriceNum - item.entryPrice) / item.entryPrice) * 100;
            
            // Protect against Infinity/NaN corrupting total yield
            if (!isNaN(itemYield) && isFinite(itemYield)) {
              totalYieldSum += itemYield;
              validYieldCount++;
            }
            
            const yieldColor = itemYield >= 0 ? 'var(--up)' : 'var(--down)';
            const yieldArrow = itemYield >= 0 ? '▲' : '▼';
            yieldMarkup = \`
              <div class="yield-row">
                <div class="yield-lbl">Basis: \$\${item.entryPrice.toFixed(2)}</div>
                <div class="yield-val" style="color:\${yieldColor}">Yield: \${yieldArrow}\${Math.abs(itemYield).toFixed(2)}%</div>
              </div>
            \`;
          }
        }

        const trackBtnText = item.entryPrice === null ? 'TRACK' : 'UNTRACK';
        const trackBtnClass = 'btn' + (item.entryPrice !== null ? ' btn-primary' : '');

        return \`
          <div class="card">
            <div class="card-top">
              <div>
                <div class="sym">\${d.symbol}</div>
                <div class="name">\${d.name}</div>
              </div>
              <div class="price">
                <div class="p-val">\$\${d.price}</div>
                <div class="p-change \${upDown}">\${arrow} \${Math.abs(changeNum).toFixed(2)} (\${d.changePercent}%)</div>
              </div>
            </div>
            \${yieldMarkup}
            <div class="card-links">
              <button class="\${trackBtnClass}" onclick="toggleTrackYield('\${d.symbol}', '\${d.price}')">\${trackBtnText}</button>
              <a href="#" class="btn btn-primary" onclick="openChart('\${d.symbol}'); return false;">CHART</a>
              <a href="#" class="btn btn-primary" onclick="openScreener('\${d.symbol}'); return false;">SCREENER</a>
            </div>
            <button class="remove-btn" onclick="removeStock('\${d.symbol}')">[Drop Element]</button>
          </div>
        \`;
      } catch(e) {
        return \`<div class="card"><div class="sym">\${item.symbol}</div><div class="name" style="color:var(--down)">NET_TIMEOUT</div></div>\`;
      }
    }));

    // Race condition guard: if a newer render was triggered, abort DOM update
    if (myRequestId !== renderRequestId) return;

    container.innerHTML = html.join('');

    // Compute aggregate structural profile metrics inside the layout header wrapper
    if (validYieldCount > 0) {
      const avgYield = totalYieldSum / validYieldCount;
      const avgSign = avgYield >= 0 ? '▲' : '▼';
      const scoreElement = document.getElementById('alpha-score');
      scoreElement.innerText = \`YIELD: \${avgSign}\${Math.abs(avgYield).toFixed(2)}%\`;
      scoreElement.style.color = avgYield >= 0 ? 'var(--up)' : 'var(--down)';
    } else {
      document.getElementById('alpha-score').innerText = 'YIELD: --';
      document.getElementById('alpha-score').style.color = 'var(--accent)';
    }
  }

  function statBox(label, value) {
    const cls = (value === 'N/A' || value === undefined || value === null) ? 'stat-val na' : 'stat-val';
    return \`<div class="stat"><div class="stat-lbl">\${label}</div><div class="\${cls}">\${value}</div></div>\`;
  }

  function infoRow(label, value) {
    const cls = (value === 'N/A' || value === undefined || value === null) ? 'stat-val na' : 'stat-val';
    return \`<div class="info-row"><div class="stat-lbl">\${label}</div><div class="\${cls}">\${value}</div></div>\`;
  }

  async function openChart(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' · 1Y Daily';
    body.innerHTML = '<div class="empty">COMPUTING PATHWAYS...</div>';
    modal.classList.add('show');

    try {
      const [stockRes, fundRes] = await Promise.all([
        fetch('/api/stock?s=' + symbol),
        fetch('/api/fundamentals?s=' + symbol).catch(() => null)
      ]);
      const d = await stockRes.json();
      let marketCap = d.marketCap;
      
      if (fundRes && fundRes.ok) {
        const f = await fundRes.json();
        if (f.available && !f.isCrypto && f.valuation && f.valuation.marketCap !== 'N/A') {
          marketCap = f.valuation.marketCap;
        }
      }

      if (!d.closes || d.closes.length < 2) {
        body.innerHTML = '<div class="empty">No historical coordinate points returned.</div>';
        requestAnimationFrame(() => modal.focus());
        return;
      }

      const data = d.closes;
      const times = d.timestamps && d.timestamps.length === data.length ? d.timestamps : [];

      const w = 260, h = 240; 
      const padL = 4, padR = 48, padT = 15, padB = 24;
      const chartW = w - padL - padR;
      const chartH = h - padT - padB;

      const rawMin = Math.min(...data), rawMax = Math.max(...data);
      const pad = (rawMax - rawMin) * 0.08 || rawMax * 0.02 || 1;
      const yMin = rawMin - pad;
      const yMax = rawMax + pad;
      const yRange = (yMax - yMin) || 1;

      const stepX = chartW / (data.length - 1);
      const toX = (i) => padL + i * stepX;
      const toY = (v) => padT + chartH - ((v - yMin) / yRange) * chartH;

      let pathData = '';
      data.forEach((val, i) => {
        pathData += (i === 0 ? 'M' : 'L') + toX(i).toFixed(2) + ',' + toY(val).toFixed(2) + ' ';
      });

      const lastX  = toX(data.length - 1);
      const firstX = toX(0);
      const bottomY = padT + chartH;
      const areaPath = pathData +
        'L' + lastX.toFixed(2) + ',' + bottomY.toFixed(2) + ' ' +
        'L' + firstX.toFixed(2) + ',' + bottomY.toFixed(2) + ' Z';

      const isUp = parseFloat(d.change) >= 0;
      const color = isUp ? '#00ff00' : '#ff0000';
      const safeId = 'g_' + symbol.replace(/[^a-zA-Z0-9]/g, '');

      const gridLines = [];
      const priceLines = 5;
      for (let g = 0; g < priceLines; g++) {
        const frac = g / (priceLines - 1);
        const yVal = yMin + yRange * frac;
        const yPos = padT + chartH - frac * chartH;
        gridLines.push({ y: yPos, val: yVal });
      }

      const monthMarkers = [];
      if (times.length) {
        let lastKey = '';
        for (let i = 0; i < times.length; i++) {
          const dt = new Date(times[i] * 1000);
          const key = dt.getFullYear() + '-' + dt.getMonth();
          if (key !== lastKey) {
            monthMarkers.push({
              x: toX(i),
              label: dt.toLocaleDateString('en-US', { month: 'short' })
            });
            lastKey = key;
          }
        }
      }

      const lastY = toY(data[data.length - 1]);
      const lastPriceNum = parseFloat(d.price) || data[data.length - 1];

      let hiIdx = 0, loIdx = 0;
      data.forEach((v, i) => {
        if (v > data[hiIdx]) hiIdx = i;
        if (v < data[loIdx]) loIdx = i;
      });
      const hiY = toY(data[hiIdx]);
      const loY = toY(data[loIdx]);
      const hiX = toX(hiIdx);
      const loX = toX(loIdx);

      body.innerHTML = \`
        <div class="card-top">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
        <div id="chart-container">
          <svg class="chart-svg" viewBox="0 0 \${w} \${h}" preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id="\${safeId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="\${color}" stop-opacity="0.35"/>
                <stop offset="60%" stop-color="\${color}" stop-opacity="0.08"/>
                <stop offset="100%" stop-color="\${color}" stop-opacity="0"/>
              </linearGradient>
            </defs>
            \${gridLines.map(g => \`
              <line class="tv-grid" x1="\${padL}" y1="\${g.y.toFixed(2)}" x2="\${padL + chartW}" y2="\${g.y.toFixed(2)}" />
              <text class="tv-price-lbl" x="\${padL + chartW + 4}" y="\${(g.y + 4).toFixed(2)}">\${g.val.toFixed(2)}</text>
            \`).join('')}
            \${monthMarkers.map(m => \`
              <line class="tv-grid-month" x1="\${m.x.toFixed(2)}" y1="\${padT}" x2="\${m.x.toFixed(2)}" y2="\${padT + chartH}" />
              <text class="tv-month-lbl" x="\${m.x.toFixed(2)}" y="\${h - 6}" text-anchor="middle">\${m.label}</text>
            \`).join('')}
            <line class="tv-axis" x1="\${padL}" y1="\${(padT + chartH).toFixed(2)}" x2="\${padL + chartW}" y2="\${(padT + chartH).toFixed(2)}" />
            <line class="tv-axis" x1="\${(padL + chartW).toFixed(2)}" y1="\${padT}" x2="\${(padL + chartW).toFixed(2)}" y2="\${padT + chartH}" />
            <path d="\${areaPath}" fill="url(#\${safeId})" />
            <path d="\${pathData}" fill="none" stroke="\${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
            <line class="tv-last-line" stroke="\${color}" x1="\${hiX.toFixed(2)}" y1="\${hiY.toFixed(2)}" x2="\${padL + chartW}" y2="\${hiY.toFixed(2)}" opacity="0.25"/>
            <line class="tv-last-line" stroke="\${color}" x1="\${loX.toFixed(2)}" y1="\${loY.toFixed(2)}" x2="\${padL + chartW}" y2="\${loY.toFixed(2)}" opacity="0.25"/>
            <circle cx="\${hiX.toFixed(2)}" cy="\${hiY.toFixed(2)}" r="1.8" fill="\${color}" opacity="0.55"/>
            <circle cx="\${loX.toFixed(2)}" cy="\${loY.toFixed(2)}" r="1.8" fill="\${color}" opacity="0.55"/>
            <line class="tv-last-line" stroke="\${color}" x1="\${padL}" y1="\${lastY.toFixed(2)}" x2="\${(padL + chartW).toFixed(2)}" y2="\${lastY.toFixed(2)}" />
            <rect x="\${(padL + chartW + 1).toFixed(2)}" y="\${(lastY - 6).toFixed(2)}" width="\${padR - 2}" height="12" fill="\${color}" rx="1.5"/>
            <text class="tv-tag-txt" x="\${(padL + chartW + 4).toFixed(2)}" y="\${(lastY + 3).toFixed(2)}" fill="#000">\${lastPriceNum.toFixed(2)}</text>
            <circle cx="\${lastX.toFixed(2)}" cy="\${lastY.toFixed(2)}" r="2.8" fill="\${color}" />
            <circle cx="\${lastX.toFixed(2)}" cy="\${lastY.toFixed(2)}" r="5" fill="\${color}" opacity="0.25" />
          </svg>
        </div>
        <div class="timeline-label">
          <span>\${d.startDate}</span>
          <span style="color:var(--accent);">1Y · Daily Close</span>
          <span>\${d.endDate}</span>
        </div>
        <div class="grid">
          \${statBox('1Y High', d.yearHigh)}
          \${statBox('1Y Low', d.yearLow)}
          \${statBox('Volume', d.volume)}
          \${statBox('Mkt Cap', marketCap)}
        </div>
      \`;
    } catch(e) {
      body.innerHTML = '<div class="empty">Chart processing pipeline failure.</div>';
    }
    requestAnimationFrame(() => {
      modal.scrollTop = 0;
      modal.focus();
    });
  }

  async function openScreener(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' Fundamentals';
    body.innerHTML = '<div class="empty">DECODING FINANCIAL LEDGERS...</div>';
    modal.classList.add('show');

    try {
      const [stockRes, fundRes] = await Promise.all([
        fetch('/api/stock?s=' + symbol),
        fetch('/api/fundamentals?s=' + symbol)
      ]);
      const d = await stockRes.json();
      const f = await fundRes.json();

      const isCrypto = symbol.includes('-USD') || symbol.includes('-EUR');

      let html = \`
        <div class="card-top" style="margin-bottom:4px;">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
      \`;

      if (isCrypto || f.isCrypto || !f.available) {
        const disclaimer = (isCrypto || f.isCrypto) 
          ? "Crypto assets do not have traditional corporate fundamentals." 
          : "Deep fundamentals are temporarily unavailable for this asset (International Market or Key required).";
        
        html += \`
          <div class="fund-unavailable">
            \${disclaimer}<br>
            Price, volume and 1Y range below come from the live market feed.
          </div>
          <div class="fund-section-title">Trading Range Profile</div>
          <div class="grid">
            \${statBox('1Y High', d.yearHigh)}
            \${statBox('1Y Low', d.yearLow)}
            \${statBox('Volume', d.volume)}
            \${statBox('Mkt Cap', d.marketCap)}
          </div>
        \`;
        body.innerHTML = html;
        requestAnimationFrame(() => modal.focus());
        return;
      }

      const v = f.valuation, ps = f.perShare, pr = f.profitability, g = f.growth,
            dv = f.dividends, tr = f.trading, an = f.analyst, co = f.company, fh = f.financialHealth;

      html += \`
        <div class="fund-section-title">Valuation</div>
        <div class="grid">
          \${statBox('Mkt Cap', v.marketCap)}
          \${statBox('P/E (TTM)', v.peTrailing)}
          \${statBox('P/E (Fwd)', v.peForward)}
          \${statBox('Price/Book', v.priceToBook)}
          \${statBox('Price/Sales', v.priceToSales)}
        </div>

        <div class="fund-section-title">Per Share</div>
        <div class="grid">
          \${statBox('EPS', ps.eps)}
          \${statBox('Book Value', ps.bookValue)}
          \${statBox('Revenue/Shr', ps.revenuePerShare)}
        </div>

        <div class="fund-section-title">Profitability</div>
        <div class="grid">
          \${statBox('Gross Margin', pr.grossMargin)}
          \${statBox('Oper. Margin', pr.operatingMargin)}
          \${statBox('Net Margin', pr.profitMargin)}
          \${statBox('ROE', pr.roe)}
          \${statBox('ROA', pr.roa)}
        </div>

        <div class="fund-section-title">Growth (YoY)</div>
        <div class="grid">
          \${statBox('Revenue Gr.', g.revenueGrowth)}
          \${statBox('Earnings Gr.', g.earningsGrowth)}
        </div>

        <div class="fund-section-title">Dividends</div>
        <div class="grid">
          \${statBox('Yield', dv.yield)}
          \${statBox('Per Share', dv.perShare)}
        </div>

        <div class="fund-section-title">Financial Health</div>
        <div class="grid">
          \${statBox('Debt/Equity', fh.debtToEquity)}
          \${statBox('Current Ratio', fh.currentRatio)}
          \${statBox('Quick Ratio', fh.quickRatio)}
        </div>

        <div class="fund-section-title">Trading Stats</div>
        <div class="grid">
          \${statBox('Beta', tr.beta)}
          \${statBox('52W High', tr.fiftyTwoWeekHigh)}
          \${statBox('52W Low', tr.fiftyTwoWeekLow)}
          \${statBox('Shares Out', tr.sharesOutstanding)}
        </div>

        <div class="fund-section-title">Analyst Ratings</div>
        <div class="grid">
          \${statBox('Strong Buy', an.strongBuy)}
          \${statBox('Buy', an.buy)}
          \${statBox('Hold', an.hold)}
          \${statBox('Sell', an.sell)}
          \${statBox('Strong Sell', an.strongSell)}
        </div>

        <div class="fund-section-title">Company</div>
        <div>
          \${infoRow('Sector', co.sector)}
          \${infoRow('Exchange', co.exchange)}
          \${infoRow('Country', co.country)}
          \${infoRow('IPO Date', co.ipo)}
        </div>
      \`;

      body.innerHTML = html;
    } catch(e) {
      body.innerHTML = '<div class="empty">Ledger interpretation timeout error.</div>';
    }
    requestAnimationFrame(() => {
      modal.scrollTop = 0;
      modal.focus();
    });
  }

  function closeModal() {
    document.getElementById('modal').classList.remove('show');
  }

  // Execute structural generation loop on application wake context
  renderWatchlist();
</script>
</body>
</html>
  `;
}
