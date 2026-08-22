import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const serviceWorker=readFileSync(resolve(import.meta.dirname,'../../public/sw.js'),'utf8')
const pagesFallback=readFileSync(resolve(import.meta.dirname,'../../public/404.html'),'utf8')

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
