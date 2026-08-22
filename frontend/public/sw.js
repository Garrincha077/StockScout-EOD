const CACHE='stockscout-eod-shell-v2'
const SHELL=['./','./404.html','./manifest.webmanifest','./icons/stockscout.svg']
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())))
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())))
self.addEventListener('message',event=>{
  if(event.data?.type!=='CACHE_SCAN'||!Array.isArray(event.data.urls))return
  const urls=event.data.urls.filter(value=>{
    try{
      const url=new URL(value,self.location.origin)
      return url.origin===self.location.origin&&(url.pathname.endsWith('/data/manifest.json')||url.pathname.includes('/data/runs/'))
    }catch{return false}
  })
  event.waitUntil(caches.open(CACHE).then(async cache=>{
    for(const url of urls){
      const response=await fetch(url)
      if(response.ok)await cache.put(url,response)
    }
  }))
})
self.addEventListener('fetch',event=>{
  const request=event.request
  if(request.method!=='GET')return
  const url=new URL(request.url)
  // Authenticated storage and API responses must never enter a public cache,
  // even if a future deployment proxies Supabase through the app origin.
  const isPrivate=url.hostname.endsWith('.supabase.co')||url.pathname.includes('/storage/v1/')||url.pathname.includes('/auth/v1/')||request.headers.has('authorization')
  if(url.origin!==self.location.origin||isPrivate)return
  const isManifest=url.pathname.endsWith('/data/manifest.json')
  const isImmutable=url.pathname.includes('/data/runs/')||url.searchParams.has('v')
  if(isManifest){
    event.respondWith(fetch(request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));return response}).catch(()=>caches.match(request)))
    return
  }
  if(isImmutable){
    event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response})))
    return
  }
  if(['script','style','font','image'].includes(request.destination)){
    event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response})))
    return
  }
  if(request.mode==='navigate')event.respondWith(fetch(request).then(response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);const copy=response.clone();caches.open(CACHE).then(cache=>cache.put('./',copy));return response}).catch(()=>caches.match('./')))
})
