export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API Route: Search for tickers by company name
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return json([]);
      
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const data = await res.json();
      
      const results = (data.quotes || [])
        .filter(q => q.quoteType === 'EQUITY' || q.quotetype === 'ETF')
        .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol }));
        
      return json(results);
    }

    // API Route: Fetch stock data (quote + chart + fundamentals)
    if (url.pathname === '/api/stock') {
      const symbol = url.searchParams.get('s');
      if (!symbol) return json({ error: 'No symbol' }, 400);

      const yfSymbol = symbol.replace('.', '-');
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?range=1mo&interval=1d`;
      const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${yfSymbol}?modules=price,summaryDetail,financialData,defaultKeyStatistics`;

      const [chartRes, summaryRes] = await Promise.allSettled([
        fetch(chartUrl, { headers }),
        fetch(summaryUrl, { headers })
      ]);

      let price = 0, prevClose = 0, name = symbol, closes = [], volume = 0, marketCap = 0;
      let fundamentals = {};

      if (chartRes.status === 'fulfilled' && chartRes.value.ok) {
        const chartJson = await chartRes.value.json();
        if (chartJson.chart && chartJson.chart.result) {
          const result = chartJson.chart.result[0];
          closes = result.indicators.quote[0].close.filter(c => c !== null);
          price = result.meta.regularMarketPrice;
          prevClose = result.meta.chartPreviousClose;
          volume = result.meta.regularMarketVolume;
          name = result.meta.shortName || result.meta.longName || symbol;
        }
      }

      if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
        const sumJson = await summaryRes.value.json();
        if (sumJson.quoteSummary && sumJson.quoteSummary.result) {
          const res = sumJson.quoteSummary.result[0];
          if (res.price) {
            if (res.price.regularMarketPrice) price = res.price.regularMarketPrice.raw;
            if (res.price.shortName) name = res.price.shortName;
            if (res.price.marketCap) marketCap = res.price.marketCap.raw;
          }
          if (res.summaryDetail) {
            if (res.summaryDetail.trailingPE) fundamentals.pe = res.summaryDetail.trailingPE.raw.toFixed(2);
            if (res.summaryDetail.volume) volume = res.summaryDetail.volume.raw;
          }
          if (res.financialData) {
            if (res.financialData.totalRevenue) fundamentals.revenue = formatLargeNum(res.financialData.totalRevenue.raw);
            if (res.financialData.quickRatio) fundamentals.quickRatio = res.financialData.quickRatio.raw.toFixed(2);
            if (res.financialData.currentRatio) fundamentals.currentRatio = res.financialData.currentRatio.raw.toFixed(2);
            if (res.financialData.debtToEquity) fundamentals.de = res.financialData.debtToEquity.raw.toFixed(2);
            if (res.financialData.returnOnEquity) fundamentals.roe = (res.financialData.returnOnEquity.raw * 100).toFixed(1) + '%';
          }
        }
      }

      const change = price - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;

      return json({
        symbol,
        name: name.length > 25 ? name.substring(0, 22) + '...' : name,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        marketCap: marketCap ? formatLargeNum(marketCap) : 'N/A',
        volume: volume ? formatLargeNum(volume) : 'N/A',
        closes,
        fundamentals
      });
    }

    // Serve the Single Page Application
    return new Response(getAppHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// --- Helper Functions ---
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

// --- The Modern UI & Client-Side App ---
function getAppHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>StockTracker Pro</title>
<style>
  :root {
    --bg: #0f1117; --card: #1a1d29; --border: #2a2e3d; 
    --text: #e4e7eb; --muted: #8b8f9b; 
    --up: #0ecb81; --down: #f6465d; --accent: #1e90ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding-bottom: 40px; }
  header { background: var(--card); padding: 16px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  h1 { font-size: 18px; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .logo { width: 12px; height: 12px; background: var(--accent); border-radius: 2px; box-shadow: 0 0 8px var(--accent); }
  .search-container { position: relative; }
  input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 16px; outline: none; }
  input:focus { border-color: var(--accent); }
  #search-results { display: none; position: absolute; top: 48px; left: 0; right: 0; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  #search-results.show { display: block; }
  .res-item { padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .res-item:active { background: var(--bg); }
  .res-sym { font-weight: 700; color: var(--accent); font-size: 14px; }
  .res-name { font-size: 12px; color: var(--muted); margin-top: 2px; }
  
  .card { background: var(--card); margin: 12px; padding: 16px; border-radius: 12px; border: 1px solid var(--border); }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .sym { font-size: 18px; font-weight: 700; }
  .name { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .price { text-align: right; }
  .p-val { font-size: 18px; font-weight: 700; }
  .p-change { font-size: 12px; font-weight: 600; margin-top: 2px; }
  .up { color: var(--up); } .down { color: var(--down); }
  
  .card-links { display: flex; gap: 8px; margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
  .btn { flex: 1; text-align: center; padding: 10px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; border: 1px solid var(--border); color: var(--text); background: var(--bg); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn:active { transform: scale(0.98); }
  .remove-btn { color: var(--down); background: transparent; border: none; font-size: 12px; margin-top: 8px; cursor: pointer; padding: 0; }

  /* Modal */
  #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 100; padding: 20px; overflow-y: auto; }
  #modal.show { display: block; }
  .modal-content { background: var(--card); border-radius: 12px; padding: 16px; border: 1px solid var(--border); margin-top: 20px; }
  .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .close-btn { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; width: 30px; height: 30px; font-size: 16px; cursor: pointer; }
  
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .stat { background: var(--bg); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
  .stat-lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; }
  .stat-val { font-size: 16px; font-weight: 600; margin-top: 4px; }
  
  #chart-container { height: 150px; margin: 16px 0; position: relative; }
  svg { width: 100%; height: 100%; overflow: visible; }
  .empty { text-align: center; padding: 40px 20px; color: var(--muted); }
</style>
</head>
<body>

<header>
  <h1><div class="logo"></div> StockTracker Pro</h1>
  <div class="search-container">
    <input type="text" id="search-input" placeholder="Search company (e.g. Google)" autocomplete="off">
    <div id="search-results"></div>
  </div>
</header>

<div id="watchlist"></div>

<div id="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2 id="modal-title">Details</h2>
      <button class="close-btn" onclick="closeModal()">✕</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
  let watchlist = [];

  // Init from URL (Database-free persistence)
  const urlParams = new URLSearchParams(window.location.search);
  const sParam = urlParams.get('s');
  if (sParam) watchlist = sParam.split(',').map(s => s.trim().toUpperCase()).filter(s => s);
  if (watchlist.length === 0) watchlist = ['AAPL', 'TSLA', 'MSFT'];

  function updateUrl() {
    const newUrl = window.location.pathname + '?s=' + watchlist.join(',');
    window.history.replaceState({}, '', newUrl);
  }

  // Debounce search
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
      container.innerHTML = '<div class="empty">Watchlist empty. Search to add stocks.</div>';
      return;
    }
    
    container.innerHTML = '<div class="empty">Loading market data...</div>';
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
              <a href="#" class="btn" onclick="openChart('\${sym}'); return false;">Chart</a>
              <a href="#" class="btn btn-primary" onclick="openScreener('\${sym}'); return false;">Screener</a>
            </div>
            <button class="remove-btn" onclick="removeStock('\${sym}')">REMOVE</button>
          </div>
        \`;
      } catch(e) {
        return \`<div class="card"><div class="sym">\${sym}</div><div class="name" style="color:var(--down)">Error loading data.</div></div>\`;
      }
    }));
    container.innerHTML = html.join('');
  }

  async function openChart(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' Chart';
    body.innerHTML = '<div class="empty">Loading chart...</div>';
    modal.classList.add('show');

    try {
      const res = await fetch('/api/stock?s=' + symbol);
      const d = await res.json();
      
      if (!d.closes || d.closes.length < 2) {
        body.innerHTML = '<div class="empty">No chart data available.</div>';
        return;
      }

      const data = d.closes;
      const w = 250, h = 150, p = 10;
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
      
      body.innerHTML = \`
        <div class="card-top">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
          <div class="price"><div class="p-val">\$\${d.price}</div><div class="p-change \${d.change >= 0 ? 'up' : 'down'}">\${d.changePercent}%</div></div>
        </div>
        <div id="chart-container">
          <svg viewBox="0 0 \${w} \${h}">
            <path d="\${pathData} L\${w-p},\${h-p} L\${p},\${h-p} Z" fill="\${color}" opacity="0.1" />
            <path d="\${pathData}" fill="none" stroke="\${color}" stroke-width="2" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="grid">
          <div class="stat"><div class="stat-lbl">30d High</div><div class="stat-val">\${max.toFixed(2)}</div></div>
          <div class="stat"><div class="stat-lbl">30d Low</div><div class="stat-val">\${min.toFixed(2)}</div></div>
          <div class="stat"><div class="stat-lbl">Volume</div><div class="stat-val">\${d.volume}</div></div>
          <div class="stat"><div class="stat-lbl">Mkt Cap</div><div class="stat-val">\${d.marketCap}</div></div>
        </div>
      \`;
    } catch(e) {
      body.innerHTML = '<div class="empty">Error loading chart.</div>';
    }
  }

  async function openScreener(symbol) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    title.innerText = symbol + ' Fundamentals';
    body.innerHTML = '<div class="empty">Loading fundamentals...</div>';
    modal.classList.add('show');

    try {
      const res = await fetch('/api/stock?s=' + symbol);
      const d = await res.json();
      const f = d.fundamentals;
      
      body.innerHTML = \`
        <div class="card-top" style="margin-bottom:20px;">
          <div><div class="sym">\${d.symbol}</div><div class="name">\${d.name}</div></div>
        </div>
        <div class="grid">
          <div class="stat"><div class="stat-lbl">P/E Ratio</div><div class="stat-val">\${f.pe || 'N/A'}</div></div>
          <div class="stat"><div class="stat-lbl">Mkt Cap</div><div class="stat-val">\${d.marketCap}</div></div>
          <div class="stat"><div class="stat-lbl">Revenue</div><div class="stat-val">\${f.revenue || 'N/A'}</div></div>
          <div class="stat"><div class="stat-lbl">Volume</div><div class="stat-val">\${d.volume}</div></div>
          <div class="stat"><div class="stat-lbl">Quick Ratio</div><div class="stat-val">\${f.quickRatio || 'N/A'}</div></div>
          <div class="stat"><div class="stat-lbl">Current Ratio</div><div class="stat-val">\${f.currentRatio || 'N/A'}</div></div>
          <div class="stat"><div class="stat-lbl">Debt/Equity</div><div class="stat-val">\${f.de || 'N/A'}</div></div>
          <div class="stat"><div class="stat-lbl">Return on Equity</div><div class="stat-val">\${f.roe || 'N/A'}</div></div>
        </div>
      \`;
    } catch(e) {
      body.innerHTML = '<div class="empty">Error loading fundamentals.</div>';
    }
  }

  function closeModal() {
    document.getElementById('modal').classList.remove('show');
  }

  // Initial Load
  renderWatchlist();
</script>
</body>
</html>
  `;
}
