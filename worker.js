export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Route: Ticker Search Engine
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return json([]);

      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
          headers: { 'User-Agent': UA }
        });
        const data = await res.json();
        const results = (data.quotes || [])
          .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
          .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol }));
        return json(results);
      } catch (e) {
        return json([]);
      }
    }

    // API Route: Price + 1Y chart (Live Yahoo Processing Layer)
    if (url.pathname === '/api/stock') {
      const cleanSymbol = sanitizeSymbol(url.searchParams.get('s'));
      if (!cleanSymbol) return json({ error: 'No valid symbol provided' }, 400);

      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const payload = await fetchChartData(cleanSymbol);
      const resp = json(payload);
      resp.headers.set('Cache-Control', 'public, max-age=45');
      if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    // API Route: Deep fundamentals - Finnhub Core Framework (KV Cached 24 Hours)
    if (url.pathname === '/api/fundamentals') {
      const cleanSymbol = sanitizeSymbol(url.searchParams.get('s'));
      if (!cleanSymbol) return json({ error: 'No valid symbol provided' }, 400);

      const kv = env.FUNDAMENTALS_KV;
      const kvKey = 'fundv2:' + cleanSymbol;

      if (kv) {
        try {
          const cachedStr = await kv.get(kvKey);
          if (cachedStr) return json(JSON.parse(cachedStr));
        } catch (e) {
          console.error('KV database read exception tracking payload: ', e);
        }
      }

      const data = await fetchFundamentals(cleanSymbol, env);
      const payload = { symbol: cleanSymbol, ...data };

      if (kv && data.available) {
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(kv.put(kvKey, JSON.stringify(payload), { expirationTtl: 86400 }).catch(e => console.error('KV cache write exception: ', e)));
        }
      }

      return json(payload);
    }

    return new Response(getAppHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// --- Config Configuration Setup ---
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- Global Context Formatter Core Matrix Helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function sanitizeSymbol(raw) {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().trim().replace(/[^A-Z0-9.\-^]/g, '').slice(0, 12);
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
  const pct = fraction * 100;
  const sign = pct > 0 ? '+' : '';
  return sign + pct.toFixed(decimals) + '%';
}

function fmtDividendYield(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return 'N/A';
  let pct = fraction * 100;
  if (Math.abs(pct) > 25) pct = fraction;
  return pct.toFixed(2) + '%';
}

// --- Chart Data Engine (Unmodified Yahoo Finance v8 Logic) ---
async function fetchChartData(cleanSymbol) {
  const yfSymbol = cleanSymbol.replace('.', '-');
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?range=1y&interval=1d`;

  let price = 0, prevClose = 0, name = cleanSymbol, closes = [], volume = 0, marketCap = 0;
  let startDateStr = 'N/A', endDateStr = 'N/A', yearHigh = 'N/A', yearLow = 'N/A';

  try {
    const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': UA } });
    if (chartRes.ok) {
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
        price = meta.regularMarketPrice || price;
        prevClose = meta.chartPreviousClose || prevClose;
        volume = meta.regularMarketVolume || volume;
        name = meta.shortName || meta.longName || cleanSymbol;

        if (meta.marketCap) marketCap = meta.marketCap;

        if (closes.length > 0) {
          yearHigh = Math.max(...closes).toFixed(2);
          yearLow = Math.min(...closes).toFixed(2);
          startDateStr = new Date(validPoints[0].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
          endDateStr = new Date(validPoints[validPoints.length - 1].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        }
      }
    }
  } catch (chartErr) {
    console.error('Chart pipeline fetch error: ', chartErr);
  }

  const change = price - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  return {
    symbol: cleanSymbol,
    name: name ? (name.length > 25 ? name.substring(0, 22) + '...') : name,
    price: price ? price.toFixed(2) : '0.00',
    change: change ? change.toFixed(2) : '0.00',
    changePercent: changePercent ? changePercent.toFixed(2) : '0.00',
    marketCap: marketCap ? formatLargeNum(marketCap) : 'N/A',
    volume: volume ? formatLargeNum(volume) : 'N/A',
    closes,
    startDate: startDateStr,
    endDate: endDateStr,
    yearHigh,
    yearLow
  };
}

// --- Fundamentals Engine (Pruned for Free-Tier Execution) ---
function mVal(metric, ...candidates) {
  for (const key of candidates) {
    const v = metric[key];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

async function fetchFundamentals(cleanSymbol, env) {
  const apiKey = env && env.FINNHUB_API_KEY;
  if (!apiKey) return { available: false, reason: 'missing_api_key' };

  const sym = encodeURIComponent(cleanSymbol);
  const token = encodeURIComponent(apiKey);

  try {
    // Stripped out premium endpoints (price-target) to preserve latency and avoid 403 blocks
    const [profileRes, metricRes, recRes] = await Promise.allSettled([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${token}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${token}`),
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${sym}&token=${token}`)
    ]);

    if (profileRes.status !== 'fulfilled' || !profileRes.value.ok || metricRes.status !== 'fulfilled' || !metricRes.value.ok) {
      return { available: false };
    }

    const profile = await profileRes.value.json();
    const metricBody = await metricRes.value.json();
    const metric = (metricBody && metricBody.metric) || {};

    if (!profile || !profile.name) return { available: false };

    let recommendation = null;
    if (recRes.status === 'fulfilled' && recRes.value.ok) {
      const recArr = await recRes.value.json();
      if (Array.isArray(recArr) && recArr.length > 0) recommendation = recArr[0];
    }

    const marketCapM = typeof profile.marketCapitalization === 'number' ? profile.marketCapitalization : null;
    const sharesOutM = typeof profile.shareOutstanding === 'number' ? profile.shareOutstanding : null;

    const pctMap = (key) => {
      const v = mVal(metric, key);
      return v !== null ? v / 100 : null;
    };

    return {
      available: true,
      valuation: {
        marketCap: marketCapM !== null ? formatLargeNum(marketCapM * 1e6) : 'N/A',
        peTrailing: fmtNum(mVal(metric, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peNormalizedAnnual')),
        peForward: fmtNum(mVal(metric, 'forwardPE')),
        priceToBook: fmtNum(mVal(metric, 'pb', 'pbQuarterly', 'pbAnnual')),
        priceToSales: fmtNum(mVal(metric, 'psTTM', 'psAnnual', 'ps'))
      },
      perShare: {
        eps: fmtNum(mVal(metric, 'epsBasicExclExtraItemsTTM', 'epsTTM', 'epsAnnual')),
        bookValue: fmtNum(mVal(metric, 'bookValuePerShareQuarterly', 'bookValuePerShareAnnual', 'bookValue')),
        revenuePerShare: fmtNum(mVal(metric, 'revenuePerShareTTM', 'salesPerShare'))
      },
      profitability: {
        grossMargin: fmtPct(pctMap('grossMarginTTM')),
        profitMargin: fmtPct(pctMap('netProfitMarginTTM')),
        operatingMargin: fmtPct(pctMap('operatingMarginTTM')),
        roe: fmtPct(pctMap('roeTTM')),
        roa: fmtPct(pctMap('roaTTM'))
      },
      growth: {
        revenueGrowth: fmtPct(pctMap('revenueGrowthTTMYoy')),
        earningsGrowth: fmtPct(pctMap('epsGrowthTTMYoy'))
      },
      dividends: {
        yield: fmtDividendYield((mVal(metric, 'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM') || 0) / 100),
        perShare: fmtNum(mVal(metric, 'dividendPerShareAnnual', 'dividendPerShareTTM'))
      },
      trading: {
        beta: fmtNum(mVal(metric, 'beta')),
        fiftyTwoWeekHigh: fmtNum(mVal(metric, '52WeekHigh')),
        fiftyTwoWeekLow: fmtNum(mVal(metric, '52WeekLow')),
        sharesOutstanding: sharesOutM !== null ? formatLargeNum(sharesOutM * 1e6) : 'N/A'
      },
      financialHealth: {
        debtToEquity: fmtNum(mVal(metric, 'totalDebtToEquity', 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual')),
        currentRatio: fmtNum(mVal(metric, 'currentRatio', 'currentRatioQuarterly', 'currentRatioAnnual')),
        quickRatio: fmtNum(mVal(metric, 'quickRatio', 'quickRatioQuarterly', 'quickRatioAnnual')),
        cashRatio: fmtNum(mVal(metric, 'cashRatio', 'cashRatioQuarterly', 'cashRatioAnnual'))
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
        industry: profile.finnhubIndustry || 'N/A',
        exchange: profile.exchange || 'N/A',
        country: profile.country || 'N/A'
      }
    };
  } catch (e) {
    console.error('Fundamentals tracking runtime block execution exception: ', e);
    return { available: false };
  }
}

// --- Frame UI Matrix Layout (Optimized specifically for working Free Tier variables) ---
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
  body { background: var(--bg); color: var(--text); font-family: monospace; padding-bottom: 40px; }
  header { background: var(--card); padding: 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  h1 { font-size: 14px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .logo { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
  .search-container { position: relative; }
  input { width: 100%; padding: 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 13px; font-family: monospace; outline: none; }
  input:focus { border-color: var(--accent); }
  #search-results { display: none; position: absolute; top: 42px; left: 0; right: 0; background: var(--card); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; z-index: 20; }
  #search-results.show { display: block; }
  .res-item { padding: 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .res-item:active { background: var(--bg); }
  .res-sym { font-weight: 700; color: var(--accent); font-size: 13px; }
  .res-name { font-size: 11px; color: var(--muted); margin-top: 2px; }
  
  .card { background: var(--card); margin: 8px; padding: 12px; border-radius: 4px; border: 1px solid var(--border); }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
  .sym { font-size: 15px; height: auto; font-weight: 700; color: #fff; }
  .name { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .price { text-align: right; }
  .p-val { font-size: 15px; font-weight: 700; }
  .p-change { font-size: 11px; font-weight: 600; margin-top: 2px; }
  .up { color: var(--up); } .down { color: var(--down); }
  
  .card-links { display: flex; gap: 6px; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .btn { flex: 1; text-align: center; padding: 8px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: 600; border: 1px solid var(--border); color: var(--text); background: var(--bg); }
  .btn-primary { border-color: var(--accent); color: var(--accent); }
  
  .remove-btn { color: var(--down); background: transparent; border: none; font-size: 11px; margin-top: 6px; cursor: pointer; padding: 0; text-transform: uppercase; }

  #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.95); z-index: 100; padding: 10px; overflow-y: auto; }
  #modal.show { display: block; }
  .modal-content { background: var(--card); border-radius: 4px; padding: 12px; border: 1px solid var(--border); }
  .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .close-btn { background: var(--bg); border: 1px solid var(--border); color: var(--text); width: 26px; height: 26px; font-size: 13px; cursor: pointer; }
  
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .stat { background: var(--bg); padding: 6px; border-radius: 4px; border: 1px solid var(--border); }
  .stat-lbl { font-size: 9px; color: var(--muted); text-transform: uppercase; }
  .stat-val { font-size: 12px; font-weight: 600; margin-top: 2px; }
  .stat-val.na { color: var(--muted); font-weight: 400; }

  .fund-section-title { font-size: 10px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  .fund-section-title:first-of-type { margin-top: 0; }
  .info-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
  .info-row:last-child { border-bottom: none; }
  .info-row .stat-lbl { font-size: 10px; }
  .info-row .stat-val { font-size: 11px; text-align: right; }
  .fund-unavailable { text-align: center; padding: 16px 8px; color: var(--muted); font-size: 11px; border: 1px dashed var(--border); border-radius: 4px; margin-top: 8px; line-height: 1.5; }
  
  #chart-container { height: 110px; margin: 10px 0; position: relative; }
  svg { width: 100%; height: 100%; overflow: visible; }
  .empty { text-align: center; padding: 20px; color: var(--muted); font-size: 12px; }
  .timeline-label { display: flex; justify-content: space-between; margin-top: -4px; margin-bottom: 12px; font-size: 10px; color: var(--muted); }
</style>
</head>
<body>

<header>
  <h1><div class="logo"></div> cloudphone stocktracker</h1>
  <div class="search-container">
    <input type="text" id="search-input" placeholder="Search Ticker..." autocomplete="off">
    <div id="search-results"></div>
  </div>
</header>

<div id="watchlist"></div>

<div id="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2 id="modal-title" style="font-size:13px; text-transform:uppercase;">Historical Analytics</h2>
      <button class="close-btn" onclick="closeModal()">✕</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
  let watchlist = [];

  const urlParams = new URLSearchParams(window.location.search);
  const sParam = urlParams.get('s');
  if (sParam) watchlist = sParam.split(',').map(s => s.trim().toUpperCase()).filter(s => s);
  if (watchlist.length === 0) watchlist = ['AAPL', 'MSFT', 'GOOG'];

  function updateUrl() {
    const newUrl = window.location.pathname + '?s=' + watchlist.join(',');
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
    if (!watchlist.includes(symbol)) watchlist.push(symbol);
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').classList.remove('show');
    updateUrl();
    renderWatchlist();
  }

  function removeStock(symbol) {
    watchlist = watchlist.filter(s => s !== symbol);
    updateUrl();
    renderWatchlist();
  }

  async function renderWatchlist() {
    const container = document.getElementById('watchlist');
    if (watchlist.length === 0) {
      container.innerHTML = '<div class="empty">Watchlist empty. Search and build tracking elements.</div>';
      return;
    }
    
    container.innerHTML = '<div class="empty">SYNCING MARKET MATRIX...</div>';
    const html = await Promise.all(watchlist.map(async sym => {
      try {
        const res = await fetch('/api/stock?s=' + sym);
        if (!res.ok) throw new Error("Server error code configuration response");
        const d = await res.json();
        const upDown = d.change >= 0 ? 'up' : 'down';
        const arrow = d.change >= 0 ? '▲' : '▼';
        
        return \`
          <div class="card">
            <div class="card-top">
              <div>
                <div class="sym">\${d.symbol}</div>
                <div class="name">\${d.name}</div>
              </div>
              <div class="price">
                <div class="p-val">\$\${d.price}</div>
                <div class="p-change \${upDown}">\${arrow} \${d.change} (\${d.changePercent}%)</div>
              </div>
            </div>
            <div class="card-links">
              <a href="#" class="btn" onclick="openChart('\${sym}'); return false;">CHART</a>
              <a href="#" class="btn btn-primary" onclick="openScreener('\${sym}'); return false;">SCREENER</a>
            </div>
            <button class="remove-btn" onclick="removeStock('\${sym}')">[Drop Element]</button>
          </div>
        \`;
      } catch(e) {
        return \`<div class="card"><div class="sym">\${sym}</div><div class="name" style="color:var(--down)">NET_TIMEOUT</div></div>\`;
      }
    }));
    container.innerHTML = html.join('');
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
    title.innerText = symbol + ' Vector Continuum';
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
        if (f.available && f.valuation && f.valuation.marketCap !== 'N/A') {
          marketCap = f.valuation.marketCap;
        }
      }
      
      if (!d.closes || d.closes.length < 2) {
        body.innerHTML = '<div class="empty">No historical coordinate points returned.</div>';
        return;
      }

      const data = d.closes;
      const w = 220, h = 100, p = 5;
      const min = Math.min(...data), max = Math.max(...data);
      const range = max - min || 1;
      const stepX = (w - p * 2) / (data.length - 1);
      
      let pathData = '';
      data.forEach((val, i) => {
        const x = p + i * stepX;
        const y = h - p - ((val - min) / range) * (h - p * 2);
        pathData += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
      });

      const color = d.change >= 0 ? 'var(--up)' : 'var(--down)';
      const xEnd = w - p;
      const yEnd = h - p;
      const xStart = p;
      
      body.innerHTML = \`
        <div class="card-top">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
        <div id="chart-container">
          <svg viewBox="0 0 \${w} \${h}">
            <path d="\${pathData} L\${xEnd},\${yEnd} L\${xStart},\${yEnd} Z" fill="\${color}" opacity="0.08" />
            <path d="\${pathData}" fill="none" stroke="\${color}" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="timeline-label">
          <span>\${d.startDate}</span>
          <span style="color:var(--accent);">1Y Price Vector Spectrum</span>
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
  }

  async function openScreener(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' Fundamental Data';
    body.innerHTML = '<div class="empty">DECODING FINANCIAL LEDGERS...</div>';
    modal.classList.add('show');

    try {
      const [stockRes, fundRes] = await Promise.all([
        fetch('/api/stock?s=' + symbol),
        fetch('/api/fundamentals?s=' + symbol)
      ]);
      const d = await stockRes.json();
      const f = await fundRes.json();

      let html = \`
        <div class="card-top" style="margin-bottom:4px;">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
      \`;

      if (!f.available) {
        html += \`
          <div class="fund-unavailable">
            Deep fundamentals are temporarily unavailable (API configuration required or stock not supported).<br>
            Price, volume and 1Y range below still come from the live chart feed.
          </div>
          <div class="fund-section-title">Trading Range</div>
          <div class="grid">
            \${statBox('1Y High', d.yearHigh)}
            \${statBox('1Y Low', d.yearLow)}
            \${statBox('Volume', d.volume)}
            \${statBox('Mkt Cap', d.marketCap)}
          </div>
        \`;
        body.innerHTML = html;
        return;
      }

      // Stripped dead blocks (Ownership, Peg, EV Ratios, Target Price)
      const v = f.valuation || {};
      const ps = f.perShare || {};
      const pr = f.profitability || {};
      const g = f.growth || {};
      const dv = f.dividends || {};
      const tr = f.trading || {};
      const an = f.analyst || {};
      const co = f.company || {};
      const fh = f.financialHealth || {}; 

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

        <div class="fund-section-title">Growth (YoY, Qtrly)</div>
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
          \${statBox('Cash Ratio', fh.cashRatio)}
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
          \${infoRow('Industry', co.industry)}
          \${infoRow('Exchange', co.exchange)}
          \${infoRow('Country', co.country)}
        </div>
      \`;

      body.innerHTML = html;
    } catch(e) {
      body.innerHTML = '<div class="empty">Ledger interpretation timeout error.</div>';
    }
  }

  function closeModal() {
    document.getElementById('modal').classList.remove('show');
  }

  renderWatchlist();
</script>
</body>
</html>
  `;
}
