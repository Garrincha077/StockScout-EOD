import test from 'node:test'
import assert from 'node:assert/strict'
import {privateChartPath,privateChartRows,privateChartShard} from './chartPayload.ts'

test('private chart manifest resolves one immutable owner shard',()=>{
  const shard=privateChartShard({chartShards:{AAA:'006'}},'aaa')
  assert.equal(shard,'006')
  assert.equal(privateChartPath('owner-id','run-1',shard!),'owner-id/run-1/shards/006.json.gz')
})

test('private chart shard exposes only the requested ticker rows',()=>{
  const payload={AAA:{daily:[['2026-08-21',1,2,1,2,100,1]]},BBB:{daily:[['secret-other-row']]}}
  assert.deepEqual(privateChartRows(payload,'AAA'),payload.AAA.daily)
  assert.equal(privateChartRows(payload,'CCC'),null)
})
