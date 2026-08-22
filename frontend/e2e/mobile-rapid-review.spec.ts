import {expect,test} from '@playwright/test'

const universe=Array.from({length:50},(_,index)=>({
  ticker:`T${String(index+1).padStart(3,'0')}`,
  price:10+index,
  stage:2,
  stageName:'Stage 2',
  primarySetup:index===0?'Fresh Breakout':'Fresh Stage 2',
  opportunityScore:100-index,
  opportunityTier:index<10?'READY':'WATCH',
  opportunityRank:99-index,
  opportunityPotential:90-index/2,
  opportunityTiming:80-index/2,
  rsRank:99-index,
  groupRank:80-index/2,
  fundamentalEvidenceScore:70,
  volumeRatio:1.2,
  distance10w:0,
  setupTags:['Fresh Stage 2'],
  changedToday:index<3,
  newUniverseMember:index===1,
  changeImpact:index<3?3-index:0,
  changeLabels:index<3?[`Change ${index+1}`]:[],
}))

const generatedAt='2026-08-20T08:00:00+00:00'
const payload=JSON.stringify({
  version:8,
  generatedAt,
  market:{regime:'TEST',dailyChanges:{changed:3}},
  universe,
  chartShards:{},
})
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

test('Phase 4 review scope, queue, ticker sync and Rapid Review work across viewports',async({page},testInfo)=>{
  let coreRequests=0
  page.on('pageerror',error=>console.error('PAGE ERROR:',error.message))
  page.on('console',message=>{
    if(message.type()==='error')console.error('BROWSER CONSOLE:',message.text())
  })
  const fulfillPayload=async(route:any)=>{coreRequests++;return route.fulfill({status:200,contentType:'application/json',body:payload})}
  await page.route('**/data/core.json*',fulfillPayload)
  await page.route('**/data/manifest.json*',route=>route.fulfill({status:200,contentType:'application/json',body:manifest}))
  await page.route('**/data/validation-status.json*',route=>route.fulfill({status:404,body:''}))

  const response=await page.goto('/')
  console.log('Preview response:',response?.status(),page.url())
  await expect(page.locator('.dv-app')).toBeVisible({timeout:10_000})
  await expect(page.locator('.p4-review')).toBeVisible()
  await expect(page.locator('.p4-health')).not.toContainText('Healthy')

  const todayButton=page.locator('.p4-inbox-actions button').filter({hasText:/Today/})
  const newButton=page.locator('.p4-inbox-actions button').filter({hasText:/New since last scan/})
  const gridButton=page.locator('.dv-top nav button').filter({hasText:/^Grid$/})
  const rapidHeader=page.locator('.dv-gridview > header')
  const summary=page.locator('.dv-gridview > header span')
  const cards=page.locator('.dv-minicard')
  const sentinel=page.locator('.dv-grid-sentinel')

  await expect(todayButton).toContainText('3 unseen')
  await todayButton.click()
  await expect(todayButton).toHaveClass(/active/)
  await expect(gridButton).toHaveClass(/active/)
  await expect(rapidHeader).toBeVisible()
  if(testInfo.project.name==='mobile-pixel-5')await expect(rapidHeader).toHaveCSS('position','static')
  const scope=page.locator('.p4-review-scope')
  await expect(scope).toContainText('Today / changed')
  await expect(scope).toContainText('3 candidates')
  await expect(scope).toContainText('screen membership paused')
  await expect(summary).toContainText('3 of 3')
  await expect(cards).toHaveCount(3)

  await scope.getByRole('button',{name:'List'}).click()
  await expect(page.locator('.p4-inbox-drawer')).toContainText('3 candidates')
  await expect(page.locator('.p4-inbox-drawer')).toContainText('3 unseen')

  await page.locator('.p4-inbox-list button').first().click()
  const why=page.locator('.p4-why')
  await expect(why).toBeVisible()
  await expect(why).toContainText('WHY T001?')
  await expect(why).toContainText('Review 1 / 3')
  await expect(why).toContainText('transparent decomposition')
  await expect(why).toContainText('Opportunity')
  await expect(todayButton).toContainText('2 unseen')

  await page.locator('.p4-next').click()
  await expect(why).toContainText('WHY T002?')
  await expect(why).toContainText('Review 2 / 3')
  await expect(todayButton).toContainText('1 unseen')
  await page.getByRole('button',{name:'Close why panel'}).click()

  await scope.getByRole('button',{name:'List'}).click()
  await expect(page.locator('.p4-inbox-list button.reviewed')).toHaveCount(2)
  await expect(page.locator('.p4-inbox-list button').first()).toContainText('reviewed')
  await page.getByRole('button',{name:'Close review inbox'}).click()

  await newButton.click()
  await expect(newButton).toHaveClass(/active/)
  await expect(todayButton).not.toHaveClass(/active/)
  await expect(scope).toContainText('New since last scan')
  await expect(scope).toContainText('1 candidates')
  await expect(summary).toContainText('1 of 1')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('T002')

  await page.getByRole('button',{name:'Clear review scope'}).click()
  await expect(scope).toHaveCount(0)
  await expect(gridButton).toHaveClass(/active/)

  const initialCount=await cards.count()
  expect(initialCount).toBeGreaterThanOrEqual(16)
  expect(initialCount).toBeLessThanOrEqual(50)
  await expect(summary).toContainText(`${initialCount} of 50`)
  if(testInfo.project.name==='mobile-pixel-5')expect(initialCount).toBe(16)

  // A normal Grid selection uses history.replaceState, not hashchange. The
  // Phase 4 review bar must still follow the active StockScout ticker.
  await cards.nth(3).click()
  const whyButton=page.locator('.p4-inbox-actions button').filter({hasText:/Why this stock\?/})
  await expect(whyButton).toContainText('T004',{timeout:2_000})
  expect(coreRequests).toBe(1)
  await whyButton.click()
  await expect(page.locator('.p4-why')).toContainText('WHY T004?')
  await page.getByRole('button',{name:'Close why panel'}).click()

  for(let attempt=0;attempt<5;attempt++){
    if((await summary.textContent())?.includes('50 of 50'))break
    await sentinel.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
  }

  await expect(summary).toContainText('50 of 50')
  await expect(cards).toHaveCount(50)
})
