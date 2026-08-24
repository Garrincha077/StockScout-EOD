// Compatibility entry for the only deployed shell-v2 bundle. Its cached HTML
// resolves this filename below /ticker/, so redirect before loading the app.
const match=location.pathname.match(/\/ticker\/([^/]+)\/?$/i)
const target=new URL('/StockScout-EOD/',location.origin)
target.search=location.search
if(match){
  let ticker=match[1]
  try{ticker=decodeURIComponent(ticker)}catch{}
  target.searchParams.set('ticker',ticker)
}
location.replace(target.toString())
