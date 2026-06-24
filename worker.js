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

    // API Route: Price + 1Y chart (fast, no auth needed - safe to call often)
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

    // API Route: Deep fundamentals (slower, needs a Yahoo session crumb - best effort)
    if (url.pathname === '/api/fundamentals') {
      const cleanSymbol = sanitizeSymbol(url.searchParams.get('s'));
      if (!cleanSymbol) return json({ error: 'No valid symbol provided' }, 400);

      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const yfSymbol = cleanSymbol.replace('.', '-');
      const data = await fetchFundamentals(yfSymbol);
      const resp = json({ symbol: cleanSymbol, ...data });
      resp.headers.set('Cache-Control', 'public, max-age=300');
      if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
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

// Pulls the .raw numeric value out of a Yahoo quoteSummary field, or null
function raw(field) {
  return field && typeof field.raw === 'number' && isFinite(field.raw) ? field.raw : null;
}

function fmtNum(val, decimals = 2) {
  return (val === null || val === undefined || isNaN(val)) ? 'N/A' : val.toFixed(decimals);
}

// Generic fraction -> percent (e.g. 0.245 -> "24.50%"). Used for margins,
// ROE/ROA, growth and payout ratio, none of which share dividendYield's
// historical unit ambiguity, so no extra guard is applied here.
function fmtPct(fraction, decimals = 2) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return 'N/A';
  const pct = fraction * 100;
  const sign = pct > 0 ? '+' : '';
  return sign + pct.toFixed(decimals) + '%';
}

// Yahoo has, at various points, served dividendYield as either a fraction
// (0.0045) or an already-scaled percent (0.45). Real-world dividend yields
// are essentially never above ~25%, so this is a safe sanity check either way.
function fmtDividendYield(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return 'N/A';
  let pct = fraction * 100;
  if (Math.abs(pct) > 25) pct = fraction;
  return pct.toFixed(2) + '%';
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return 'N/A';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// --- Chart + price data (Yahoo's unauthenticated v8 chart endpoint) ---
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

        // The chart endpoint occasionally carries marketCap for some
        // instrument types (e.g. certain ETFs) - use it if present, but
        // the real source of truth is /api/fundamentals.
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
    name: name ? (name.length > 25 ? name.substring(0, 22) + '...' : name) : cleanSymbol,
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

// --- Yahoo session auth (cookie + crumb) ---
// Yahoo's quoteSummary endpoint (where market cap, P/E, margins etc. live)
// requires a session cookie + crumb token, unlike the plain chart endpoint.
// This does the same "visit a page, grab the cookie, exchange it for a
// crumb" dance Yahoo's own site does. It's unofficial and can break or get
// region-gated behind a cookie-consent flow without notice - every caller
// treats a null result as "fundamentals unavailable" and degrades to N/A
// rather than failing the request.
let yfCookie = null;
let yfCrumb = null;
let yfAuthExpiry = 0;

async function getYahooAuth() {
  if (yfCookie && yfCrumb && Date.now() < yfAuthExpiry) {
    return { cookie: yfCookie, crumb: yfCrumb };
  }

  try {
    const initRes = await fetch('https://finance.yahoo.com/quote/AAPL', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'manual'
    });

    // A redirect here usually means Yahoo wants to run a cookie-consent
    // flow (seen for some EU/UK egress) which this lightweight client
    // doesn't implement - bail out cleanly instead of guessing.
    if (initRes.status >= 300 && initRes.status < 400) return null;

    const setCookies = initRes.headers.getAll ? initRes.headers.getAll('Set-Cookie') : [];
    if (!setCookies.length) return null;
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*' }
    });
    if (!crumbRes.ok) return null;

    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 50 || crumb.includes('<')) return null;

    yfCookie = cookie;
    yfCrumb = crumb;
    yfAuthExpiry = Date.now() + 20 * 60 * 1000; // reuse for ~20 min
    return { cookie, crumb };
  } catch (e) {
    console.error('Yahoo auth error: ', e);
    return null;
  }
}

// --- Fundamentals (valuation, profitability, dividends, risk, etc.) ---
async function fetchFundamentals(yfSymbol) {
  try {
    const auth = await getYahooAuth();
    if (!auth) return { available: false };

    const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile';
    const qsUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yfSymbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;

    const res = await fetch(qsUrl, {
      headers: { 'User-Agent': UA, 'Cookie': auth.cookie, 'Accept': 'application/json' }
    });

    if (!res.ok) {
      // Crumb/cookie likely went stale - drop the cache so the next
      // request gets a fresh one instead of repeating the same failure.
      yfCookie = null; yfCrumb = null; yfAuthExpiry = 0;
      return { available: false };
    }

    const body = await res.json();
    const result = body && body.quoteSummary && body.quoteSummary.result && body.quoteSummary.result[0];
    if (!result) return { available: false };

    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};
    const ap = result.assetProfile || {};

    const debtToEquityRaw = raw(fd.debtToEquity);
    const employees = ap.fullTimeEmployees;

    return {
      available: true,
      valuation: {
        marketCap: raw(sd.marketCap) !== null ? formatLargeNum(raw(sd.marketCap)) : 'N/A',
        peTrailing: fmtNum(raw(sd.trailingPE)),
        peForward: fmtNum(raw(sd.forwardPE)),
        peg: fmtNum(raw(ks.pegRatio)),
        priceToBook: fmtNum(raw(ks.priceToBook)),
        priceToSales: fmtNum(raw(sd.priceToSalesTrailing12Months)),
        evToEbitda: fmtNum(raw(ks.enterpriseToEbitda))
      },
      perShare: {
        eps: fmtNum(raw(ks.trailingEps)),
        epsForward: fmtNum(raw(ks.forwardEps)),
        bookValue: fmtNum(raw(ks.bookValue)),
        revenuePerShare: fmtNum(raw(fd.revenuePerShare))
      },
      profitability: {
        grossMargin: fmtPct(raw(fd.grossMargins)),
        operatingMargin: fmtPct(raw(fd.operatingMargins)),
        netMargin: fmtPct(raw(fd.profitMargins)),
        roe: fmtPct(raw(fd.returnOnEquity)),
        roa: fmtPct(raw(fd.returnOnAssets))
      },
      growth: {
        revenueGrowth: fmtPct(raw(fd.revenueGrowth)),
        earningsGrowth: fmtPct(raw(fd.earningsGrowth))
      },
      dividends: {
        yield: fmtDividendYield(raw(sd.dividendYield)),
        rate: fmtNum(raw(sd.dividendRate)),
        payoutRatio: fmtPct(raw(sd.payoutRatio)),
        exDividendDate: fmtDate(raw(sd.exDividendDate))
      },
      financialHealth: {
        debtToEquity: debtToEquityRaw !== null ? debtToEquityRaw.toFixed(2) : 'N/A',
        currentRatio: fmtNum(raw(fd.currentRatio)),
        quickRatio: fmtNum(raw(fd.quickRatio)),
        totalCash: raw(fd.totalCash) !== null ? formatLargeNum(raw(fd.totalCash)) : 'N/A',
        totalDebt: raw(fd.totalDebt) !== null ? formatLargeNum(raw(fd.totalDebt)) : 'N/A',
        freeCashFlow: raw(fd.freeCashflow) !== null ? formatLargeNum(raw(fd.freeCashflow)) : 'N/A'
      },
      trading: {
        beta: fmtNum(raw(sd.beta)),
        fiftyTwoWeekHigh: fmtNum(raw(sd.fiftyTwoWeekHigh)),
        fiftyTwoWeekLow: fmtNum(raw(sd.fiftyTwoWeekLow)),
        fiftyDayAvg: fmtNum(raw(sd.fiftyDayAverage)),
        twoHundredDayAvg: fmtNum(raw(sd.twoHundredDayAverage)),
        avgVolume: raw(sd.averageVolume) !== null ? formatLargeNum(raw(sd.averageVolume)) : 'N/A',
        sharesOutstanding: raw(ks.sharesOutstanding) !== null ? formatLargeNum(raw(ks.sharesOutstanding)) : 'N/A',
        shortPercentFloat: fmtPct(raw(ks.shortPercentOfFloat))
      },
      analyst: {
        recommendation: fd.recommendationKey ? fd.recommendationKey.replace(/_/g, ' ').toUpperCase() : 'N/A',
        targetMean: fmtNum(raw(fd.targetMeanPrice)),
        targetHigh: fmtNum(raw(fd.targetHighPrice)),
        targetLow: fmtNum(raw(fd.targetLowPrice)),
        numAnalysts: (typeof fd.numberOfAnalystOpinions === 'number') ? String(fd.numberOfAnalystOpinions) : 'N/A'
      },
      company: {
        sector: ap.sector || 'N/A',
        industry: ap.industry || 'N/A',
        employees: (typeof employees === 'number') ? employees.toLocaleString('en-US') : 'N/A'
      }
    };
  } catch (e) {
    console.error('Fundamentals fetch error: ', e);
    return { available: false };
  }
}

// --- Frame Layout Layout ---
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
  .stat-val.pos { color: var(--up); }
  .stat-val.neg { color: var(--down); }

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
            Deep fundamentals are temporarily unavailable from Yahoo's data feed.<br>
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

      const v = f.valuation, ps = f.perShare, pr = f.profitability, g = f.growth,
            dv = f.dividends, fh = f.financialHealth, tr = f.trading, an = f.analyst, co = f.company;

      html += \`
        <div class="fund-section-title">Valuation</div>
        <div class="grid">
          \${statBox('Mkt Cap', v.marketCap)}
          \${statBox('P/E (TTM)', v.peTrailing)}
          \${statBox('P/E (Fwd)', v.peForward)}
          \${statBox('PEG Ratio', v.peg)}
          \${statBox('Price/Book', v.priceToBook)}
          \${statBox('Price/Sales', v.priceToSales)}
          \${statBox('EV/EBITDA', v.evToEbitda)}
        </div>

        <div class="fund-section-title">Per Share</div>
        <div class="grid">
          \${statBox('EPS (TTM)', ps.eps)}
          \${statBox('EPS (Fwd)', ps.epsForward)}
          \${statBox('Book Value', ps.bookValue)}
          \${statBox('Revenue/Shr', ps.revenuePerShare)}
        </div>

        <div class="fund-section-title">Profitability</div>
        <div class="grid">
          \${statBox('Gross Margin', pr.grossMargin)}
          \${statBox('Oper. Margin', pr.operatingMargin)}
          \${statBox('Net Margin', pr.netMargin)}
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
          \${statBox('Rate', dv.rate)}
          \${statBox('Payout Ratio', dv.payoutRatio)}
          \${statBox('Ex-Div Date', dv.exDividendDate)}
        </div>

        <div class="fund-section-title">Financial Health</div>
        <div class="grid">
          \${statBox('Debt/Equity', fh.debtToEquity)}
          \${statBox('Current Ratio', fh.currentRatio)}
          \${statBox('Quick Ratio', fh.quickRatio)}
          \${statBox('Total Cash', fh.totalCash)}
          \${statBox('Total Debt', fh.totalDebt)}
          \${statBox('Free Cash Flow', fh.freeCashFlow)}
        </div>

        <div class="fund-section-title">Trading Stats</div>
        <div class="grid">
          \${statBox('Beta', tr.beta)}
          \${statBox('52W High', tr.fiftyTwoWeekHigh)}
          \${statBox('52W Low', tr.fiftyTwoWeekLow)}
          \${statBox('50D Avg', tr.fiftyDayAvg)}
          \${statBox('200D Avg', tr.twoHundredDayAvg)}
          \${statBox('Avg Volume', tr.avgVolume)}
          \${statBox('Shares Out', tr.sharesOutstanding)}
          \${statBox('Short % Float', tr.shortPercentFloat)}
        </div>

        <div class="fund-section-title">Analyst Views</div>
        <div class="grid">
          \${statBox('Rating', an.recommendation)}
          \${statBox('# Analysts', an.numAnalysts)}
          \${statBox('Target Mean', an.targetMean)}
          \${statBox('Target High', an.targetHigh)}
          \${statBox('Target Low', an.targetLow)}
        </div>

        <div class="fund-section-title">Company</div>
        <div>
          \${infoRow('Sector', co.sector)}
          \${infoRow('Industry', co.industry)}
          \${infoRow('Employees', co.employees)}
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
