import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const serviceWorker=readFileSync(resolve(import.meta.dirname,'../../public/sw.js'),'utf8')
const pagesFallback=readFileSync(resolve(import.meta.dirname,'../../public/404.html'),'utf8')
const viteConfig=readFileSync(resolve(import.meta.dirname,'../../vite.config.ts'),'utf8')
const indexHtml=readFileSync(resolve(import.meta.dirname,'../../index.html'),'utf8')
const legacyShellBridge=readFileSync(resolve(import.meta.dirname,'../../public/ticker/assets/index-CfpEZ4tL.js'),'utf8')

test('service worker excludes every authenticated Supabase surface from cache',()=>{
  assert.match(serviceWorker,/\.supabase\.co/)
  assert.match(serviceWorker,/\/storage\/v1\//)
  assert.match(serviceWorker,/\/auth\/v1\//)
  assert.match(serviceWorker,/authorization/)
  assert.match(serviceWorker,/url\.origin!==self\.location\.origin\|\|isPrivate/)
})

test('service worker uses network-first manifest and immutable public run caching only',()=>{
  assert.match(serviceWorker,/data\/manifest\.json/)
  assert.match(serviceWorker,/data\/runs\//)
  assert.match(serviceWorker,/fetch\(request\).*caches\.match\(request\)/s)
})

test('GitHub Pages fallback preserves ticker and run query for canonical links',()=>{
  assert.match(pagesFallback,/ticker\\\/\(\[\^\/\]\+\)/)
  assert.match(pagesFallback,/params\.set\('ticker'/)
  assert.match(pagesFallback,/location\.replace/)
})

test('GitHub Pages shell uses repository-absolute assets and repairs canonical ticker navigation',()=>{
  assert.match(viteConfig,/base:'\/StockScout-EOD\/'/)
  assert.match(viteConfig,/ticker\/assets/)
  assert.match(indexHtml,/%BASE_URL%manifest\.webmanifest/)
  assert.match(indexHtml,/%BASE_URL%icons\/stockscout\.svg/)
  assert.match(serviceWorker,/stockscout-eod-shell-v3/)
  assert.match(serviceWorker,/tickerMatch/)
  assert.match(serviceWorker,/target\.search=url\.search/)
  assert.match(serviceWorker,/target\.searchParams\.set\('ticker'/)
  assert.match(serviceWorker,/Response\.redirect/)
  assert.match(legacyShellBridge,/new URL\('\/StockScout-EOD\/'/)
  assert.match(legacyShellBridge,/target\.searchParams\.set\('ticker'/)
  assert.match(legacyShellBridge,/location\.replace/)
})
