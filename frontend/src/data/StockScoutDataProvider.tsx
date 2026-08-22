import {createContext,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from 'react'
import type {ReviewScope} from '../phase4Review'
import {
  detailShardFor,isManifestV1,normalizeCore,parseManifest,
  type AssetDescriptor,type CandidateCoreV1,type CandidateDetailV1,
  type ScanHistoryItemV1,type StockScoutManifest,
} from './contracts'

export type {AssetDescriptor,CandidateDetailV1,CandidateSummaryV1,ScanHistoryItemV1,StockScoutManifest} from './contracts'
export type StockScoutRow={ticker:string;[key:string]:any}
export type StockScoutCore=CandidateCoreV1
export type LegacyIndex={generatedAt:string;market:Record<string,any>;layers?:Record<string,any>;universe:StockScoutRow[];[key:string]:any}
export type ChartState=
  |{status:'ready';rows:any[]}
  |{status:'unavailable';rows:[];reason?:'private'|'missing'}
  |{status:'error';rows:[];error:string}

type LoadOptions={cache?:RequestCache;force?:boolean;cacheBust?:boolean}
type FetchLike=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>

export class JsonPromiseCache{
  private pending=new Map<string,Promise<unknown>>()
  constructor(private fetcher:FetchLike=(input,init)=>fetch(input,init)){}

  load<T>(key:string,url:string,options:LoadOptions={}):Promise<T>{
    if(options.force)this.pending.delete(key)
    const existing=this.pending.get(key)
    if(existing)return existing as Promise<T>
    const requestUrl=options.cacheBust?`${url}${url.includes('?')?'&':'?'}retry=${Date.now()}`:url
    const request=this.fetcher(requestUrl,{cache:options.cache??'default'})
      .then(response=>{
        if(!response.ok)throw new Error(`HTTP ${response.status}`)
        if(!response.headers.get('content-type')?.includes('json'))throw new Error('Published scan data is not available yet')
        return response.json() as Promise<T>
      })
      .catch(error=>{this.pending.delete(key);throw error})
    this.pending.set(key,request)
    return request
  }

  delete(key:string){this.pending.delete(key)}
  clear(){this.pending.clear()}
}

export const sharedDataCache=new JsonPromiseCache()

const initialPath=location.pathname
const tickerRouteIndex=initialPath.toLowerCase().indexOf('/ticker/')
const APP_ROOT=tickerRouteIndex>=0?`${initialPath.slice(0,tickerRouteIndex)}/`:initialPath.endsWith('/')?initialPath:initialPath.replace(/[^/]+$/,'')
const DATA_ROOT=new URL(`${APP_ROOT}data/`,location.origin)
function dataUrl(path:string){return new URL(path.replace(/^\.?\/?data\//,'').replace(/^\//,''),DATA_ROOT).toString()}
function versionedUrl(asset:AssetDescriptor,path=asset.path){return`${dataUrl(path)}?v=${encodeURIComponent(asset.sha256)}`}
function tickerUrl(ticker:string,manifest:StockScoutManifest|null){
  const run=manifest&&isManifestV1(manifest)?`?run=${encodeURIComponent(manifest.runId)}`:''
  return`${APP_ROOT}ticker/${encodeURIComponent(ticker)}${run}`
}
function initialTicker(){
  const route=location.pathname.match(/\/ticker\/([^/]+)/i)?.[1]
  const query=new URLSearchParams(location.search).get('ticker')
  const hash=location.hash.replace(/^#/,'')
  return decodeURIComponent(route||query||hash||'').trim().toUpperCase()
}
function detailFromPayload(value:unknown,ticker:string):StockScoutRow|null{
  if(!value||typeof value!=='object')return null
  const payload=value as Record<string,any>
  const row=(payload.ticker===ticker?payload:null)??payload[ticker]??payload.byTicker?.[ticker]??payload.candidates?.find?.((item:any)=>item?.ticker===ticker)
  return row&&typeof row==='object'?row as StockScoutRow:null
}

function retainValidatedScan(urls:string[]){
  if(!('serviceWorker'in navigator))return
  navigator.serviceWorker.ready
    .then(registration=>registration.active?.postMessage({type:'CACHE_SCAN',urls}))
    .catch(()=>undefined)
}
function expandCompactFundamentals(core:StockScoutCore):StockScoutCore{
  return{...core,universe:core.universe.map(row=>{
    const dims=row.fundamentalDims
    if(!Array.isArray(dims))return row
    return{...row,
      fundamentalGrowthScore:row.fundamentalGrowthScore??dims[0]??null,
      fundamentalMarginScore:row.fundamentalMarginScore??dims[1]??null,
      fundamentalInventoryScore:row.fundamentalInventoryScore??dims[2]??null,
    }
  })}
}

type DataContextValue={
  manifest:StockScoutManifest|null
  core:StockScoutCore|null
  loading:boolean
  error:string
  selectedTicker:string
  selectTicker:(ticker:string)=>void
  reviewScope:ReviewScope
  setReviewScope:(scope:ReviewScope)=>void
  reload:()=>void
  loadCandidateDetail:(ticker:string,force?:boolean)=>Promise<CandidateDetailV1|null>
  loadExcluded:()=>Promise<StockScoutRow[]>
  loadHistory:()=>Promise<ScanHistoryItemV1[]>
  loadLegacyIndex:()=>Promise<LegacyIndex>
  loadLegacyDetail:(ticker:string,force?:boolean)=>Promise<StockScoutRow|null>
  loadChart:(ticker:string,retry?:boolean)=>Promise<ChartState>
  loadOptional:<T>(path:string)=>Promise<T|null>
}

const DataContext=createContext<DataContextValue|null>(null)

export function StockScoutDataProvider({children}:{children:ReactNode}){
  const[manifest,setManifest]=useState<StockScoutManifest|null>(null)
  const[core,setCore]=useState<StockScoutCore|null>(null)
  const[loading,setLoading]=useState(true)
  const[error,setError]=useState('')
  const[selectedTicker,setSelectedTicker]=useState(initialTicker)
  const[reviewScope,setReviewScope]=useState<ReviewScope>(null)
  const[revision,setRevision]=useState(0)

  useEffect(()=>{
    let live=true
    setLoading(true)
    ;(async()=>{
      const manifestUrl=dataUrl('manifest.json')
      const rawManifest=await sharedDataCache.load<unknown>('manifest',manifestUrl,{cache:'no-cache',force:true})
      const nextManifest=parseManifest(rawManifest)
      if(nextManifest.manifestVersion===1&&nextManifest.status==='failed')throw new Error('Latest scan failed its health gate')
      const coreAsset=nextManifest.assets.core
      const coreUrl=versionedUrl(coreAsset)
      const rawCore=await sharedDataCache.load<unknown>(`core:${coreAsset.sha256}`,coreUrl,{cache:'default'})
      const nextCore=expandCompactFundamentals(normalizeCore(rawCore,nextManifest))
      retainValidatedScan([manifestUrl,coreUrl])
      if(live){
        setManifest(nextManifest);setCore(nextCore);setError('')
        setSelectedTicker(current=>{
          const resolved=current||nextCore.universe[0]?.ticker||''
          if(resolved)history.replaceState(null,'',tickerUrl(resolved,nextManifest))
          return resolved
        })
      }
    })().catch(nextError=>{if(live)setError(nextError instanceof Error?nextError.message:String(nextError))}).finally(()=>{if(live)setLoading(false)})
    return()=>{live=false}
  },[revision])

  useEffect(()=>{
    const sync=()=>setSelectedTicker(initialTicker())
    window.addEventListener('hashchange',sync);window.addEventListener('popstate',sync)
    return()=>{window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync)}
  },[])

  const selectTicker=useCallback((ticker:string)=>{
    const next=ticker.trim().toUpperCase()
    if(!next)return
    setSelectedTicker(next)
    history.replaceState(null,'',tickerUrl(next,manifest))
  },[manifest])

  const reload=useCallback(()=>{
    sharedDataCache.clear();setManifest(null);setCore(null);setError('');setRevision(value=>value+1)
  },[])

  const loadCandidateDetail=useCallback(async(ticker:string,force=false):Promise<CandidateDetailV1|null>=>{
    if(!manifest||!core)throw new Error('Manifest is not ready')
    const normalized=ticker.trim().toUpperCase()
    const asset=isManifestV1(manifest)?manifest.assets.details:manifest.assets.details??manifest.assets.legacyDetails
    const explicit=core.detailShards?.[normalized]
    const shard=explicit??detailShardFor(normalized,asset.shardCount??asset.bucketCount)
    const suffix=shard.endsWith('.json')?shard:`${shard}.json`
    const expanded=asset.pattern?.replace('{bucket}',shard).replace('{ticker}',normalized)
    const path=expanded
      ?(expanded.includes('/')?expanded:`${asset.path.replace(/\/$/,'')}/${expanded}`)
      :`${asset.path.replace(/\/$/,'')}/${suffix}`
    const payload=await sharedDataCache.load<unknown>(
      `detail:${asset.sha256}:${shard}`,versionedUrl(asset,path),
      {cache:force?'no-store':'default',force,cacheBust:force},
    )
    return detailFromPayload(payload,normalized) as CandidateDetailV1|null
  },[manifest,core])

  const loadExcluded=useCallback(async()=>{
    if(!manifest||!isManifestV1(manifest))return[]
    const asset=manifest.assets.excluded
    const payload=await sharedDataCache.load<unknown>(`excluded:${asset.sha256}`,versionedUrl(asset),{cache:'default'})
    if(Array.isArray(payload))return payload as StockScoutRow[]
    if(payload&&typeof payload==='object')return((payload as any).rows??(payload as any).excluded??(payload as any).universe??[]) as StockScoutRow[]
    return[]
  },[manifest])

  const loadHistory=useCallback(async()=>{
    if(!manifest||!isManifestV1(manifest))return[]
    const asset=manifest.assets.history
    const payload=await sharedDataCache.load<unknown>(`history:${asset.sha256}`,versionedUrl(asset),{cache:'default'})
    if(Array.isArray(payload))return payload as ScanHistoryItemV1[]
    if(payload&&typeof payload==='object')return((payload as any).sessions??(payload as any).runs??(payload as any).history??[]) as ScanHistoryItemV1[]
    return[]
  },[manifest])

  const loadLegacyIndex=useCallback(async()=>{
    if(!manifest||!core)throw new Error('Manifest is not ready')
    const asset=manifest.assets.legacyIndex
    if(!asset)return{generatedAt:core.generatedAt,market:core.market,universe:core.universe as StockScoutRow[]}
    return sharedDataCache.load<LegacyIndex>(`legacy-index:${asset.sha256}`,versionedUrl(asset),{cache:'default'})
  },[manifest,core])

  const loadLegacyDetail=useCallback(async(ticker:string,force=false)=>{
    if(!manifest)throw new Error('Manifest is not ready')
    if(isManifestV1(manifest)&&!manifest.assets.legacyDetails)return loadCandidateDetail(ticker,force)
    const normalized=ticker.trim().toUpperCase()
    const asset=manifest.assets.legacyDetails!
    const shard=detailShardFor(normalized,asset.shardCount)
    const path=`${asset.path.replace(/\/$/,'')}/${shard}.json`
    const rows=await sharedDataCache.load<unknown>(
      `legacy-detail:${asset.sha256}:${shard}`,versionedUrl(asset,path),
      {cache:force?'no-store':'default',force,cacheBust:force},
    )
    return detailFromPayload(rows,normalized)
  },[manifest,loadCandidateDetail])

  const loadChart=useCallback(async(ticker:string,retry=false):Promise<ChartState>=>{
    if(!manifest||!core)return{status:'error',rows:[],error:'Dataset is not ready'}
    const asset=manifest.assets.charts
    if(!asset||asset.private)return{status:'unavailable',rows:[],reason:'private'}
    const normalized=ticker.trim().toUpperCase()
    const shard=core.chartShards?.[normalized]
    if(!shard)return{status:'unavailable',rows:[],reason:'missing'}
    try{
      const rows=await sharedDataCache.load<Record<string,any[]>>(
        `chart:${asset.sha256}:${shard}`,versionedUrl(asset,`${asset.path.replace(/\/$/,'')}/${shard}`),
        {cache:retry?'no-store':'default',force:retry,cacheBust:retry},
      )
      return rows[normalized]?.length?{status:'ready',rows:rows[normalized]}:{status:'unavailable',rows:[],reason:'missing'}
    }catch(nextError){return{status:'error',rows:[],error:String(nextError)}}
  },[manifest,core])

  const loadOptional=useCallback(async<T,>(path:string):Promise<T|null>=>{
    try{return await sharedDataCache.load<T>(`optional:${path}`,dataUrl(path),{cache:'no-cache'})}
    catch{return null}
  },[])

  const value=useMemo<DataContextValue>(()=>({
    manifest,core,loading,error,selectedTicker,selectTicker,reviewScope,setReviewScope,reload,
    loadCandidateDetail,loadExcluded,loadHistory,loadLegacyIndex,loadLegacyDetail,loadChart,loadOptional,
  }),[manifest,core,loading,error,selectedTicker,selectTicker,reviewScope,reload,loadCandidateDetail,loadExcluded,loadHistory,loadLegacyIndex,loadLegacyDetail,loadChart,loadOptional])

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useStockScoutData(){
  const value=useContext(DataContext)
  if(!value)throw new Error('useStockScoutData must be used within StockScoutDataProvider')
  return value
}
