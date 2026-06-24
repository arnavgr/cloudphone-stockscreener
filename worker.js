export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API Route: Ticker Search Engine
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return json([]);
      
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
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

    // API Route: Complete Unified Unblocked Processing Engine
    if (url.pathname === '/api/stock') {
      const symbol = url.searchParams.get('s');
      if (!symbol) return json({ error: 'No symbol provided' }, 400);

      const cleanSymbol = symbol.toUpperCase().trim();
      const yfSymbol = cleanSymbol.replace('.', '-');

      // Query Yahoo's unblocked 1-Year structural chart dataset
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?range=1y&interval=1d`;
      
      let price = 0, prevClose = 0, name = cleanSymbol, closes = [], volume = 0, marketCap = 0;
      let startDateStr = 'N/A', endDateStr = 'N/A', yearHigh = 'N/A', yearLow = 'N/A';

      try {
        const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (chartRes.ok) {
          const chartJson = await chartRes.json();
          if (chartJson.chart && chartJson.chart.result) {
            const result = chartJson.chart.result[0];
            const meta = result.meta || {};
            const quoteIndicator = result.indicators.quote[0];
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
            
            // Extract core financial metadata fields hiding inside the unblocked endpoint
            price = meta.regularMarketPrice || price;
            prevClose = meta.chartPreviousClose || prevClose;
            volume = meta.regularMarketVolume || volume;
            name = meta.shortName || meta.longName || cleanSymbol;
            
            // Extract Market Cap natively from Yahoo's unblocked chart meta layer
            if (meta.marketCap) {
              marketCap = meta.marketCap;
            }

            if (closes.length > 0) {
              yearHigh = Math.max(...closes).toFixed(2);
              yearLow = Math.min(...closes).toFixed(2);
              startDateStr = new Date(validPoints[0].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
              endDateStr = new Date(validPoints[validPoints.length - 1].time * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
            }
          }
        }
      } catch (chartErr) {
        console.error("Chart pipeline fetch error: ", chartErr);
      }

      const change = price - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;

      // Map fundamental stats directly from the clean, unblocked Yahoo endpoint properties
      return json({
        symbol: cleanSymbol,
        name: name ? (name.length > 25 ? name.substring(0, 22) + '...' : name) : cleanSymbol,
        price: price ? price.toFixed(2) : "0.00",
        change: change ? change.toFixed(2) : "0.00",
        changePercent: changePercent ? changePercent.toFixed(2) : "0.00",
        marketCap: marketCap ? formatLargeNum(marketCap) : 'N/A',
        volume: volume ? formatLargeNum(volume) : 'N/A',
        closes,
        startDate: startDateStr,
        endDate: endDateStr,
        yearHigh,
        yearLow
      });
    }

    return new Response(getAppHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// --- Helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function formatLargeNum(num) {
  if (!num || isNaN(num)) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toString();
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
                <div class="name">\text{\${d.name}}</div>
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
          <svg viewBox="0 0 \text{\${w}} \text{\text{\${h}}}">
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
      
      // Clean, unblocked framework mapping 100% stable fields natively from the unblocked endpoint
      body.innerHTML = \`
        <div class="card-top" style="margin-bottom:12px;">
          <div><div class="sym">\${d.symbol}</div><div class="name">\text{\${d.name}}</div></div>
        </div>
        <div class="grid">
          <div class="stat"><div class="stat-lbl">Mkt Cap</div><div class="stat-val">\${d.marketCap}</div></div>
          <div class="stat"><div class="stat-lbl">Volume</div><div class="stat-val">\${d.volume}</div></div>
          <div class="stat"><div class="stat-lbl">1Y High Price</div><div class="stat-val">\${d.yearHigh}</div></div>
          <div class="stat"><div class="stat-lbl">1Y Low Price</div><div class="stat-val">\${d.yearLow}</div></div>
          <div class="stat"><div class="stat-lbl">Matrix Origin</div><div class="stat-val">\${d.startDate}</div></div>
          <div class="stat"><div class="stat-lbl">Matrix Target</div><div class="stat-val">\${d.endDate}</div></div>
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
