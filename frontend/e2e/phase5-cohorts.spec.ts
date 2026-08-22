import {expect,test} from '@playwright/test'

const universe=Array.from({length:50},(_,index)=>({
  ticker:`T${String(index+1).padStart(3,'0')}`,
  price:20+index,
  stage:2,
  stageName:'Stage 2',
  opportunityScore:100-index,
  opportunityRank:99-index,
  opportunityPotential:90-index/2,
  opportunityTiming:85-index/2,
  rsRank:99-index,
  volumeRatio:1.1,
  extended:false,
  emergingLeaderCandidate:index===1,
  emergingLeaderScore:index===1?82:40,
  legacyConfirmationStatus:index===0?'CONFIRMED':index===1?'EARLY':index===2?'RISK':'NEUTRAL',
  legacyConfirmationReasons:index===0?['ORIGINAL_RUN_BUY']:index===1?['TREND_TEMPLATE_PASS']:index===2?['ORIGINAL_RUN_SELL']:['NO_FROZEN_CONFIRMATION_TRIGGER'],
  originalTTPasses:index===1?6:8,
  originalBreakoutVolumeConfirmed:index===0,
  originalRunSellSignal:index===2,
  originalSellScore:index===2?85:0,
  setupTags:['Fresh Stage 2'],
}))

const generatedAt='2026-08-20T08:00:00+00:00'
const payload=JSON.stringify({version:8,generatedAt,market:{regime:'TEST',dailyChanges:{}},universe,chartShards:{}})
const manifest=JSON.stringify({
  manifestVersion:2,model:'test',generatedAt,universe:50,
  marketSession:{date:'2099-01-01',status:'closed',timezone:'America/New_York'},
  provenance:{source:{kind:'canonical-audit',path:'latest.json',sha256:'source',bytes:1},publication:{kind:'frontend-projection',model:'test',sourceSha256:'source'}},
  assets:{
    core:{path:'core.json',sha256:'core',bytes:1,coverage:50,coveragePct:100},
    legacyIndex:{path:'legacy/index.json',sha256:'index',bytes:1,coverage:50,coveragePct:100},
    legacyDetails:{path:'legacy/details',sha256:'details',bytes:1,coverage:50,coveragePct:100,shardCount:128},
    legacyConfirmation:{path:'shadow/legacy-confirmation.json',sha256:'confirmation',bytes:1,coverage:50,coveragePct:100},
    charts:{path:'charts',sha256:'charts',bytes:0,coverage:0,coveragePct:0,shardCount:128},
  },
})

test('Phase 5 built-in discovery cohorts filter transparently without changing default screen',async({page})=>{
  const fulfillPayload=async(route:any)=>route.fulfill({status:200,contentType:'application/json',body:payload})
  await page.route('**/data/core.json*',fulfillPayload)
  await page.route('**/data/manifest.json*',route=>route.fulfill({status:200,contentType:'application/json',body:manifest}))
  await page.route('**/data/validation-status.json*',route=>route.fulfill({status:404,body:''}))

  await page.goto('/')
  await expect(page.locator('.dv-app')).toBeVisible({timeout:10_000})
  const picker=page.locator('.dv-screenpick select')
  await expect(picker).toHaveValue('')

  const options=await picker.locator('option').allTextContents()
  for(const name of ['Early Leaders','Confirmed Leaders','Ahead of Minervini','Breakout Confirmed','Watchlist Risk']){
    expect(options).toContain(name)
  }

  const rows=page.locator('.dv-tablewrap tbody tr')
  const cases:[string,number,string][]=[
    ['Confirmed Leaders',1,'T001'],
    ['Early Leaders',8,'T002'],
    ['Ahead of Minervini',1,'T002'],
    ['Breakout Confirmed',1,'T001'],
    ['Watchlist Risk',1,'T003'],
  ]
  for(const [name,count,ticker] of cases){
    await picker.selectOption({label:name})
    await expect(rows).toHaveCount(count)
    await expect(rows.first()).toContainText(ticker)
  }
})
