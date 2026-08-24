import {expect,test} from '@playwright/test'

const generatedAt=new Date().toISOString()
const runId='20260821-close'
const asset=(path:string,count:number)=>({path,sha256:`sha-${path}`,bytes:10,count})
const manifest={
  manifestVersion:1,schemaVersion:'stockscout-eod/v1',runId,sessionDate:'2026-08-21',generatedAt,status:'healthy',priceMode:'eod',
  counts:{candidates:2,excluded:1,total:3},provenance:{primary:'test'},versions:{ranking:'frozen',detectors:'fixture',tradePlan:'v1'},
  assets:{
    core:asset(`runs/${runId}/core.json`,2),details:{...asset(`runs/${runId}/details`,2),shardCount:128},
    excluded:asset(`runs/${runId}/excluded.json`,1),history:asset(`runs/${runId}/history.json`,1),
  },
}
const rows=[
  {id:`scan:${runId}:candidate:AAA`,ticker:'AAA',scanOrder:0,focusBlend:81,price:50,stage:2,stageName:'Stage 2',primarySetup:'Launch / RWB',setupTags:['Launch / RWB'],opportunityScore:50,rsRank:95,tradeStatus:'entry_ready',entryRiskPct:8,tacticalStopLevel:46,changedToday:true,changeLabels:['Fresh trigger']},
  {id:`scan:${runId}:candidate:BBB`,ticker:'BBB',scanOrder:1,focusBlend:75,price:40,stage:2,stageName:'Stage 2',primarySetup:'Crash Base',setupTags:['Crash Base'],opportunityScore:99,rsRank:90,tradeStatus:'trigger_pending',entryRiskPct:9,changedToday:false,newUniverseMember:true},
]
const core={schemaVersion:'stockscout-eod/candidate-summary/v1',runId,sessionDate:'2026-08-21',generatedAt,market:{regime:{state:'under_pressure',guppy_state:'RWB',summary:'Uptrend under pressure'}},universe:rows,detailShards:{AAA:'006',BBB:'012'}}
const details={
  AAA:{...rows[0],tradePlan:{status:'entry_ready',reasonCodes:['fresh_breakout'],triggerState:'fresh',triggerReferenceLevel:51,entryReferenceLevel:50,structuralInvalidationLevel:46,entryRiskPct:8,extensionAtr:.2,tacticalStopLevel:46,tacticalRiskPct:8,source:'primary',version:'v1'}},
  BBB:{...rows[1],tradePlan:{status:'trigger_pending',reasonCodes:['below_trigger'],triggerState:'pending',triggerReferenceLevel:42,entryReferenceLevel:42,structuralInvalidationLevel:38,entryRiskPct:9.5,extensionAtr:-.4,tacticalStopLevel:39,tacticalRiskPct:7,source:'primary',version:'v1'}},
}

test('v1 EOD app is responsive, trade-safe and public-chart safe',async({page},testInfo)=>{
  const privateRequests:string[]=[]
  page.on('request',request=>{if(/supabase|storage\/v1|auth\/v1/i.test(request.url()))privateRequests.push(request.url())})
  await page.route('**/data/manifest.json*',route=>route.fulfill({json:manifest}))
  await page.route(`**/data/runs/${runId}/core.json*`,route=>route.fulfill({json:core}))
  await page.route(`**/data/runs/${runId}/details/*.json*`,route=>route.fulfill({json:details}))
  await page.route(`**/data/runs/${runId}/excluded.json*`,route=>route.fulfill({json:[{ticker:'ZZZ',scanOrder:0,price:2,stage:4,stageName:'Stage 4',tradeStatus:'not_tradeable',reasonCodes:['low_liquidity']}] }))
  await page.route(`**/data/runs/${runId}/history.json*`,route=>route.fulfill({json:[{runId,sessionDate:'2026-08-21',generatedAt,status:'healthy',coveragePct:99.8,candidateCount:2,excludedCount:1},{runId:'20260820-close',sessionDate:'2026-08-20',generatedAt,status:'degraded',coveragePct:96,candidateCount:2,excludedCount:2}] }))
  await page.route('**/data/validation-status.json*',route=>route.fulfill({status:404,body:''}))

  await page.goto(`/StockScout-EOD/ticker/AAA?run=${runId}`)
  await expect(page).toHaveURL(new RegExp(`/ticker/AAA\\?run=${runId}$`))
  await expect(page.locator('.dv-brand')).toContainText('STOCKSCOUT EOD')
  await expect(page.locator('.dv-brand')).toContainText('2026-08-21')
  await expect(page.locator('.dv-live > b')).toHaveText('UNDER PRESSURE')
  await page.locator('.dv-groups-launch').evaluate((button:HTMLButtonElement)=>button.click())
  await expect(page.locator('.grp-top')).toContainText('UNDER PRESSURE')
  await page.locator('.grp-top button').evaluate((button:HTMLButtonElement)=>button.click())
  await expect(page.locator('.dv-tablewrap tbody tr').first()).toContainText('AAA')
  await expect(page.locator('.dv-detailhead')).toContainText('STOCKSCOUT · FOCUS BLEND')
  await expect(page.locator('.dv-detailhead')).toContainText('81.0')
  const plan=page.locator('.trade-plan')
  await expect(plan).toContainText('Entry ready')
  await expect(plan).toContainText('Ulazni trigger')
  await expect(plan).toContainText('$46.00')
  await expect(page.getByLabel('Portfolio NAV')).toHaveValue('10000000')
  await expect(page.locator('.position-sizer')).toContainText('12,500')
  await expect(page.locator('.dv-chartmsg a')).toHaveAttribute('href',/tradingview\.com/)

  await page.locator('.dv-tablewrap tbody tr').filter({hasText:'BBB'}).click()
  await expect(page).toHaveURL(new RegExp(`/ticker/BBB\\?run=${runId}$`))
  await expect(plan).toContainText('Trigger pending')
  await expect(plan).toContainText('Nije definiran — sizing onemogućen')
  await expect(plan.locator('.trade-levels .disabled')).not.toContainText('$39.00')
  await expect(page.locator('.position-sizer')).toContainText('Sizing is available only for entry-ready setups')

  await page.locator('.dv-top nav button').filter({hasText:/^Grid$/}).click()
  const columns=(await page.locator('.dv-chartgrid').evaluate(node=>getComputedStyle(node).gridTemplateColumns)).split(' ').length
  expect(columns).toBe(testInfo.project.name==='mobile-pixel-5'?1:4)
  await page.locator('.dv-top nav button').filter({hasText:/^Excluded/}).click()
  await expect(page.locator('.dv-tablewrap')).toContainText('ZZZ')
  await expect(page.locator('.dv-tablewrap')).toContainText('low liquidity')
  await page.locator('.dv-top nav button').filter({hasText:/^History/}).click()
  await expect(page.locator('.dv-market')).toContainText('2026-08-20')
  await expect(page.locator('.dv-market')).toContainText('2')
  await page.locator('.dv-top nav button').filter({hasText:/^Market$/}).evaluate((button:HTMLButtonElement)=>button.click())
  await expect(page.locator('.dv-market')).toContainText('Regime UNDER PRESSURE')
  expect(privateRequests).toEqual([])
})
