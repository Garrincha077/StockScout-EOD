export function privateChartShard(manifest:any,ticker:string):string|null{
  const normalized=ticker.trim().toUpperCase()
  const value=manifest?.chartShards?.[normalized]??manifest?.shardsByTicker?.[normalized]??manifest?.byTicker?.[normalized]??manifest?.tickers?.[normalized]
  return typeof value==='string'&&value?value:null
}

export function privateChartPath(userId:string,runId:string,shard:string){
  const root=`${userId}/${runId}`,filename=shard.endsWith('.json.gz')?shard:`${shard}.json.gz`
  return filename.includes('/')?`${root}/${filename}`:`${root}/shards/${filename}`
}

export function privateChartRows(payload:any,ticker:string):unknown[]|null{
  const normalized=ticker.trim().toUpperCase()
  const candidate=payload?.[normalized]??payload?.byTicker?.[normalized]??payload?.candidates?.[normalized]
  if(Array.isArray(candidate))return candidate
  if(Array.isArray(candidate?.daily))return candidate.daily
  if(Array.isArray(candidate?.rows))return candidate.rows
  return null
}
