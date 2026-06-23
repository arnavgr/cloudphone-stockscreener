export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle form submission to update the watchlist
    if (request.method === 'POST') {
      const formData = await request.formData();
      const symbols = formData.get('symbols') || '';
      // Redirect to the new URL with the watchlist as a query parameter
      return Response.redirect(`${url.origin}/?s=${encodeURIComponent(symbols)}`, 302);
    }

    // Get watchlist from URL param (allows bookmarking on feature phones)
    const symbolsParam = url.searchParams.get('s') || 'AAPL,MSFT,GOOG';
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);

    let html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=240, initial-scale=1">
<title>TERM_SCANNER</title>
<style>
  body { background:#000; color:#0f0; font-family:monospace; font-size:14px; margin:5px; line-height:1.2; }
  pre { margin:0; white-space: pre-wrap; word-wrap: break-word; }
  input, button { background:#000; color:#0f0; border:1px solid #0f0; font-family:monospace; font-size:14px; padding:2px; }
  input { width: 140px; }
  .red { color: #f00; }
  .dim { color: #080; }
</style>
</head>
<body>
<pre>
> SYS_INIT...
> FETCHING_DATA...
============================
 <b>STOCK_TERM v1.0</b>
============================
`;

    // Fetch data for all symbols in parallel
    const results = await Promise.all(symbols.map(s => fetchStockData(s)));

    results.forEach(data => {
      if (data.error) {
        html += `\n[${data.symbol}] <span class="red">ERR: ${data.error}</span>\n`;
        return;
      }
      
      const colorClass = data.change >= 0 ? '' : 'red';
      const arrow = data.change >= 0 ? '▲' : '▼';
      
      html += `
[${data.symbol}] ${data.name.substring(0, 20)}
PRICE: $${data.price} <span class="${colorClass}">${arrow}${Math.abs(data.changePercent).toFixed(2)}%</span>
CHART: ${data.sparkline}
RSI14: ${data.rsi}   P/E:  ${data.pe}
D/E:   ${data.de}    ROE:  ${data.roe}
----------------------------
`;
    });

    html += `
<a href="/">[REFRESH]</a>
============================
<form method="POST">
WATCH: <input name="symbols" value="${symbolsParam}"><br>
<button type="submit">SAVE</button>
</form>
============================
</pre>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

async function fetchStockData(symbol) {
  // Replace dots with hyphens for Yahoo Finance API compatibility (e.g., BRK.B -> BRK-B)
  const yfSymbol = symbol.replace('.', '-');
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  
  // Yahoo Finance endpoints
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?range=1mo&interval=1d`;
  const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfSymbol}?modules=financialData,summaryDetail,price`;
  
  try {
    // Use Promise.allSettled so if one endpoint fails, we still get partial data
    const [chartRes, summaryRes] = await Promise.allSettled([
      fetch(chartUrl, { headers }),
      fetch(summaryUrl, { headers })
    ]);

    let closes = [];
    let price = null;
    let prevClose = null;
    let name = symbol;
    
    // 1. Parse Chart Data (Price, Sparkline, RSI)
    if (chartRes.status === 'fulfilled' && chartRes.value.ok) {
      const chartJson = await chartRes.value.json();
      if (chartJson.chart && chartJson.chart.result) {
        const result = chartJson.chart.result[0];
        closes = result.indicators.quote[0].close.filter(c => c !== null);
        price = result.meta.regularMarketPrice;
        prevClose = result.meta.chartPreviousClose;
        name = result.meta.longName || result.meta.shortName || symbol;
      } else {
        return { symbol, error: 'INVALID SYMBOL' };
      }
    }

    // 2. Parse Summary Data (Fundamentals)
    let pe = 'N/A';
    let de = 'N/A';
    let roe = 'N/A';
    
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      const summaryJson = await summaryRes.value.json();
      if (summaryJson.quoteSummary && summaryJson.quoteSummary.result) {
        const res = summaryJson.quoteSummary.result[0];
        if (res.price && res.price.regularMarketPrice) price = res.price.regularMarketPrice.raw;
        if (res.price && res.price.shortName) name = res.price.shortName;
        
        if (res.summaryDetail && res.summaryDetail.trailingPE) pe = res.summaryDetail.trailingPE.raw.toFixed(1);
        if (res.financialData) {
          if (res.financialData.debtToEquity) de = res.financialData.debtToEquity.raw.toFixed(1);
          if (res.financialData.returnOnEquity) roe = (res.financialData.returnOnEquity.raw * 100).toFixed(1) + '%';
        }
      }
    }

    // Calculate Change
    const change = price - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;

    return {
      symbol,
      name,
      price: price ? price.toFixed(2) : 'N/A',
      change,
      changePercent,
      sparkline: generateSparkline(closes),
      rsi: calculateRSI(closes) || 'N/A',
      pe,
      de,
      roe
    };
  } catch (e) {
    return { symbol, error: 'NET_ERR' };
  }
}

// Calculate 14-day Relative Strength Index
function calculateRSI(closes) {
  if (closes.length < 15) return null;
  
  let gains = 0, losses = 0;
  // Look at the last 14 days of changes
  for (let i = closes.length - 14; i < closes.length; i++) {
    let diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  
  if (avgLoss === 0) return 100;
  let rs = avgGain / avgLoss;
  return (100 - (100 / (1 + rs))).toFixed(1);
}

// Generate a 20-character ASCII sparkline
function generateSparkline(closes) {
  if (!closes || closes.length < 2) return '-------';
  const blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
  
  // Get the last 20 data points to fit the narrow screen
  const recentCloses = closes.slice(-20);
  
  const min = Math.min(...recentCloses);
  const max = Math.max(...recentCloses);
  const range = max - min || 1;
  
  return recentCloses.map(c => {
    let idx = Math.floor((c - min) / range * 7);
    if (idx < 0) idx = 0;
    if (idx > 7) idx = 7;
    return blocks[idx];
  }).join('');
}
