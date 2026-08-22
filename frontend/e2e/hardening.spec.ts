import {expect,test} from '@playwright/test'

const universe=Array.from({length:205},(_,index)=>({
  ticker:`T${String(index+1).padStart(3,'0')}`,
  price:20+index,stage:2,stageName:'Stage 2',primarySetup:'Fresh Stage 2',setupTags:['Fresh Stage 2'],
  opportunityScore:100-index/4,rsRank:99-index/3,volumeRatio:1.2,originalBuyScore:80-index/10,
  originalBuy:index===0,originalRunBuySignal:index===0,originalTTPasses:8,originalVcpQuality:0,
  legacyConfirmationStatus:index===0?'CONFIRMED':'NEUTRAL',legacyConfirmationReasons:[],
}))
const generatedAt='2026-08-20T08:00:00+00:00'
const core={version:8,generatedAt,market:{regime:'TEST',dailyChanges:{}},universe,chartShards:{T001:'001.json'}}
const legacyIndex={generatedAt,market:{regime:'TEST',originalSignalGate:{gate:{should_generate_buys:true,should_generate_sells:true}}},layers:{legacy:{upstreamCommit:'2fce788b7c95e595bdbb012bd35d3a92fcc49e5a'}},universe}
const engine={model:'original-signal-engine-v1',phase:2,phaseConfidence:90,buy:{score:80,isBuy:true,emittedByOriginalRun:true,components:{},reasons:[]},sell:{score:0,reasons:[]},minervini:{passed:8,passes:true,criteria:{}},vcp:{quality:0,contractions:[]},breakout:{}}
const details=Object.fromEntries(universe.map(row=>[row.ticker,{...row,originalEngine:engine}]))
const asset=(path:string,sha256:string,coverage=205)=>({path,sha256,bytes:1,coverage,coveragePct:coverage?100:0})
const manifest={
  manifestVersion:2,model:'test',generatedAt,universe:205,
  marketSession:{date:'2099-01-01',status:'closed',timezone:'America/New_York'},
  provenance:{source:{kind:'canonical-audit',path:'latest.json',sha256:'source',bytes:1},publication:{kind:'frontend-projection',model:'test',sourceSha256:'source'}},
  assets:{
    core:asset('core.json','core'),legacyIndex:asset('legacy/index.json','index'),
    legacyDetails:{...asset('legacy/details','details'),shardCount:128},
    legacyConfirmation:asset('shadow/legacy-confirmation.json','confirmation'),
    charts:{...asset('charts','charts',1),shardCount:128},
  },
}

test('shared data, filter validation, chart states, and paged LEGACY details are hardened',async({page})=>{
  let coreRequests=0,detailRequests=0,chartRequests=0
  page.on('pageerror',error=>console.error('PAGE ERROR:',error.message))
  await page.route('**/data/manifest.json*',route=>route.fulfill({json:manifest}))
  await page.route('**/data/core.json*',route=>{coreRequests++;return route.fulfill({json:core})})
  await page.route('**/data/validation-status.json*',route=>route.fulfill({status:404,body:''}))
  await page.route('**/data/legacy/index.json*',route=>route.fulfill({json:legacyIndex}))
  await page.route('**/data/legacy/details/*.json*',route=>{detailRequests++;return route.fulfill({json:details})})
  await page.route('**/data/charts/001.json*',route=>{
    chartRequests++
    if(chartRequests===1)return route.fulfill({status:503,body:'temporary'})
    return route.fulfill({json:{T001:[['2026-08-19',10,12,9,11,1000,1]]}})
  })

  await page.goto('/')
  await expect(page.locator('.dv-app')).toBeVisible()
  await expect(page.locator('.dv-chartmsg')).toContainText('failed')
  await page.locator('.dv-chartmsg button').click()
  await expect(page.locator('.dv-chart canvas').first()).toBeVisible()
  expect(chartRequests).toBe(2)

  await page.locator('.dv-toolbar button').filter({hasText:'ANY / ALL Builder'}).click()
  await page.locator('.dv-builderhead button').filter({hasText:'+ Group'}).click()
  const invalidRule=page.locator('.dv-rule.invalid')
  const ruleInput=page.locator('.dv-rule input')
  await expect(invalidRule).toContainText('Enter a value')
  await expect(page.locator('.dv-screenpick button').filter({hasText:'Save as'})).toBeDisabled()
  await expect(page.locator('.dv-screenmeta')).toContainText('invalid · ignored')
  await ruleInput.fill('not-a-number')
  await expect(invalidRule).toContainText('valid number')
  await ruleInput.fill('999')
  await expect(page.locator('.dv-tablewrap tbody tr')).toHaveCount(0)
  await ruleInput.fill('80')

  await page.locator('.dv-groups-launch').click()
  await expect(page.locator('.grp-app')).toBeVisible()
  await page.locator('.grp-top button').click()
  await expect(page.locator('.dv-app')).toBeVisible()
  expect(coreRequests).toBe(1)

  await page.locator('.ss-layer-switch button.legacy').click()
  await expect(page.locator('.lg-app,.lg-loading')).toBeVisible()
  await expect(page.locator('.lg-app')).toBeVisible()
  await expect(page.locator('.lg-tablewrap tbody tr')).toHaveCount(100)
  await expect(page.locator('.lg-detail')).toContainText('SOURCE SCORE ANATOMY')
  expect(detailRequests).toBe(1)

  await page.locator('.ss-layer-switch button').filter({hasText:'STOCKSCOUT'}).click()
  await page.locator('.oe-launch').click()
  await expect(page.locator('.oe-body')).toBeVisible()
  expect(detailRequests).toBe(1)

  await page.locator('.oe-dock button').filter({hasText:'×'}).click()
  await page.locator('.dv-tablewrap tbody tr').filter({hasText:'T002'}).first().click()
  await expect(page.locator('.dv-chartmsg')).toContainText('unavailable for this ticker')
})
