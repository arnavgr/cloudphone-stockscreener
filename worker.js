export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fmpKey = env.FMP_API_KEY || ""; // Set this variable securely in your Cloudflare Dashboard

    // API Route: Ticker lookup engine
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return json([]);
      
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await res.json();
      const results = (data.quotes || [])
        .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
        .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol }));
        
      return json(results);
    }

    // API Route: Unified Stock Processing Engine
    if (url.pathname === '/api/stock') {
      const symbol = url.searchParams.get('s');
      if (!symbol) return json({ error: 'No symbol provided' }, 400);

      const cleanSymbol = symbol.toUpperCase().trim();
      const yfSymbol = cleanSymbol.replace('.', '-');

      // Pipeline A: Live Pricing Execution (Bypasses blocks via un-gated chart modules)
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?range=1y&interval=1d`;
      let chartRes;
      try {
        chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      } catch (e) {
        chartRes = null;
      }

      let price = 0, prevClose = 0, name = cleanSymbol, closes = [], volume = 0, marketCap = 0;
      let startDateStr = 'N/A', endDateStr = 'N/A', yearHigh = 0, yearLow = 0;

      if (chartRes && chartRes.ok) {
        const chartJson = await chartRes.json();
        if (chartJson.chart && chartJson.chart.result) {
          const result = chartJson.chart.result[0];
          const quoteIndicator = result.indicators.quote[0];
          const validPoints = [];
          
          if (result.timestamp && quoteIndicator && quoteIndicator.close) {
            result.timestamp.forEach((t, i) => {
              const c = quoteIndicator.close[i];
              if (c !== null && c !== undefined) validPoints.push({ time: t, close: c });
            });
          }
          
          closes = validPoints.map(p => p.close);
          price = result.meta.regularMarketPrice || price;
          prevClose = result.meta.chartPreviousClose || prevClose;
          volume = result.meta.regularMarketVolume || volume;
          name = result.meta.shortName || result.meta.longName || cleanSymbol;

          if (closes.length > 0) {
            yearHigh = Math.max(...closes);
            yearLow = Math.min(...closes);
            startDateStr = new Date(validPoints[0].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
            endDateStr = new Date(validPoints[validPoints.length - 1].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
          }
        }
      }

      // Pipeline B: Granular Fundamental Ratios Layer
      let fundamentals = {
        pe: 'N/A', forwardPE: 'N/A', peg: 'N/A', pb: 'N/A', ps: 'N/A', eps: 'N/A',
        currentRatio: 'N/A', quickRatio: 'N/A', de: 'N/A', roe: 'N/A',
        grossMargin: 'N/A', operatingMargin: 'N/A', netMargin: 'N/A'
      };

      if (fmpKey && fmpKey !== "demo") {
        try {
          const fmpProfileUrl = `https://financialmodelingprep.com/api/v3/profile/${cleanSymbol}?apikey=${fmpKey}`;
          const fmpRatiosUrl = `https://financialmodelingprep.com/api/v3/ratios-ttm/${cleanSymbol}?apikey=${fmpKey}`;

          const [fmpProfileRes, fmpRatiosRes] = await Promise.all([
            fetch(fmpProfileUrl, { cf: { cacheTtl: 86400, cacheEverything: true } }),
            fetch(fmpRatiosUrl, { cf: { cacheTtl: 86400, cacheEverything: true } })
          ]);

          if (fmpProfileRes.ok) {
            const pJson = await fmpProfileRes.json();
            if (pJson && pJson.length > 0) {
              marketCap = pJson[0].marketCap || marketCap; // Fixed schema pointer mapping
              fundamentals.eps = pJson[0].eps ? pJson[0].eps.toFixed(2) : 'N/A';
              if (pJson[0].companyName) name = pJson[0].companyName;
            }
          }

          if (fmpRatiosRes.ok) {
            const rJson = await fmpRatiosRes.json();
            if (rJson && rJson.length > 0) {
              const r = rJson[0];
              if (r.priceEarningsRatioTTM) fundamentals.pe = r.priceEarningsRatioTTM.toFixed(2);
              if (r.pegRatioTTM) fundamentals.peg = r.pegRatioTTM.toFixed(2);
              if (r.priceToBookRatioTTM) fundamentals.pb = r.priceToBookRatioTTM.toFixed(2);
              if (r.priceToSalesRatioTTM) fundamentals.ps = r.priceToSalesRatioTTM.toFixed(2);
              if (r.currentRatioTTM) fundamentals.currentRatio = r.currentRatioTTM.toFixed(2);
              if (r.quickRatioTTM) fundamentals.quickRatio = r.quickRatioTTM.toFixed(2);
              if (r.debtEquityRatioTTM) fundamentals.de = r.debtEquityRatioTTM.toFixed(2);
              if (r.returnOnEquityTTM) fundamentals.roe = (r.returnOnEquityTTM * 100).toFixed(1) + '%';
              if (r.grossProfitMarginTTM) fundamentals.grossMargin = (r.grossProfitMarginTTM * 100).toFixed(1) + '%';
              if (r.operatingProfitMarginTTM) fundamentals.operatingMargin = (r.operatingProfitMarginTTM * 100).toFixed(1) + '%';
              if (r.netProfitMarginTTM) fundamentals.netMargin = (r.netProfitMarginTTM * 100).toFixed(1) + '%';
            }
          }
        } catch (err) {
          console.error("API Execution Error:", err);
        }
      } else {
        // Flag to explicitly prompt parameter configuration
        fundamentals = {
          pe: 'SET_KEY', forwardPE: 'SET_KEY', peg: 'SET_KEY', pb: 'SET_KEY', ps: 'SET_KEY', eps: 'SET_KEY',
          currentRatio: 'SET_KEY', quickRatio: 'SET_KEY', de: 'SET_KEY', roe: 'SET_KEY',
          grossMargin: 'SET_KEY', operatingMargin: 'SET_KEY', netMargin: 'SET_KEY'
        };
      }

      return json({
        symbol: cleanSymbol,
        name: name.length > 25 ? name.substring(0, 22) + '...' : name,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        marketCap: marketCap ? formatLargeNum(marketCap) : 'N/A',
        volume: volume ? formatLargeNum(volume) : 'N/A',
        closes,
        startDate: startDateStr,
        endDate: endDateStr,
        yearHigh: yearHigh ? yearHigh.toFixed(2) : 'N/A',
        yearLow: yearLow ? yearLow.toFixed(2) : 'N/A',
        fundamentals
      });
    }

    return new Response(getAppHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// --- Utilities ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function formatLargeNum(num) {
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toString();
}

// --- Layout Matrix Generation ---
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
  .sym { font-size: 15px; font-weight: 700; color: #fff; }
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

  async function openChart(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' Vector Continuum';
    body.innerHTML = '<div class="empty">COMPUTING PATHWAYS...</div>';
    modal.classList.add('show');

    try {
      const res = await fetch('/api/stock?s=' + symbol);
      const d = await res.json();
      
      if (!d.closes || d.closes.length < 2) {
        body.innerHTML = '<div class="empty">No vector matrix dataset verified.</div>';
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
          <div><div class="sym">\${d.symbol}</div><div class="name">\text{\${d.name}}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
        <div id="chart-container">
          <svg viewBox="0 0 \${w} \${h}">
            <path d="\text{\${pathData}} L\${xEnd},\${yEnd} L\${xStart},\${yEnd} Z" fill="\${color}" opacity="0.08" />
            <path d="\${pathData}" fill="none" stroke="\${color}" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="timeline-label">
          <span>\${d.startDate}</span>
          <span style="color:var(--accent);">1Y Price Vector Spectrum</span>
          <span>\${d.endDate}</span>
        </div>
        <div class="grid">
          <div class="stat"><div class="stat-lbl">1Y High</div><div class="stat-val">\${d.yearHigh}</div></div>
          <div class="stat"><div class="stat-lbl">1Y Low</div><div class="stat-val">\${d.yearLow}</div></div>
          <div class="stat"><div class="stat-lbl">Volume</div><div class="stat-val">\${d.volume}</div></div>
          <div class="stat"><div class="stat-lbl">Mkt Cap</div><div class="stat-val">\${d.marketCap}</div></div>
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
      const res = await fetch('/api/stock?s=' + symbol);
      const d = await res.json();
      const f = d.fundamentals;
      
      body.innerHTML = \`
        <div class="card-top" style="margin-bottom:12px;">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
        </div>
        <div class="grid">
          <div class="stat"><div class="stat-lbl">Mkt Cap</div><div class="stat-val">\${d.marketCap}</div></div>
          <div class="stat"><div class="stat-lbl">Volume</div><div class="stat-val">\${d.volume}</div></div>
          <div class="stat"><div class="stat-lbl">P/E Ratio</div><div class="stat-val">\${f.pe}</div></div>
          <div class="stat"><div class="stat-lbl">PEG Ratio</div><div class="stat-val">\${f.peg}</div></div>
          <div class="stat"><div class="stat-lbl">P/B Ratio</div><div class="stat-val">\${f.pb}</div></div>
          <div class="stat"><div class="stat-lbl">P/S Ratio</div><div class="stat-val">\${f.ps}</div></div>
          <div class="stat"><div class="stat-lbl">EPS (TTM)</div><div class="stat-val">\${f.eps}</div></div>
          <div class="stat"><div class="stat-lbl">Current Ratio</div><div class="stat-val">\${f.currentRatio}</div></div>
          <div class="stat"><div class="stat-lbl">Liquid/Quick</div><div class="stat-val">\s\${f.quickRatio}</div></div>
          <div class="stat"><div class="stat-lbl">Debt/Equity</div><div class="stat-val">\${f.de}</div></div>
          <div class="stat"><div class="stat-lbl">Return on Equity</div><div class="stat-val">\${f.roe}</div></div>
          <div class="stat"><div class="stat-lbl">Gross Margin</div><div class="stat-val">\${f.grossMargin}</div></div>
          <div class="stat"><div class="stat-lbl">Operating Margin</div><div class="stat-val">\${f.operatingMargin}</div></div>
          <div class="stat"><div class="stat-lbl">Net Margin</div><div class="stat-val">\${f.netMargin}</div></div>
        </div>
      \`;
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
