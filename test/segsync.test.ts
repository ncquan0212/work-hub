// segsync (D27) publishes Remote Config by itself, so the pure part that decides what to append is pinned here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendIds, MAX_NEW, pickNew, segmentIds } from '../src/modules/segsync.ts'

const VALUE = JSON.stringify([
  { segment: 'general_user', campaign_id: ['*'], ad_group_id: [], enable: true },
  { segment: 'google_user', campaign_id: ['24228907159'], ad_group_id: [], enable: true },
])

test('pickNew: only new ids of the Google format with a user, most users first, renamed campaigns summed', () => {
  const rows = [
    { ua_campaign_id: '24228907159', ua_campaign: 'already in', users: 900 },
    { ua_campaign_id: '24400711880', ua_campaign: 'old name', users: 2 },
    { ua_campaign_id: '24400711880', ua_campaign: 'new name', users: 3 },
    { ua_campaign_id: '24352629483', ua_campaign: 'big', users: 40 },
    { ua_campaign_id: '24385280635', ua_campaign: 'no user', users: 0 },
    { ua_campaign_id: '6acdae47c9b6b30a98ebc6c8', ua_campaign: 'unity id', users: 99 },
    { ua_campaign_id: '52541044203966', ua_campaign: 'facebook id', users: 99 },
    { ua_campaign_id: null, ua_campaign: 'none', users: 5 },
  ]
  assert.deepEqual(pickNew(rows, new Set(segmentIds(VALUE, 'google_user'))), [
    { id: '24352629483', name: 'big', users: 40 },
    { id: '24400711880', name: 'old name', users: 5 },
  ])
})

test('appendIds: appends to the one segment only, keeps every other rule, never drops or doubles an id', () => {
  const out = JSON.parse(appendIds(VALUE, 'google_user', ['24352629483', '24228907159']))
  assert.deepEqual(out[0], JSON.parse(VALUE)[0])
  assert.deepEqual(out[1].campaign_id, ['24228907159', '24352629483'])
  assert.throws(() => appendIds(VALUE, 'missing_user', ['1']), /không có segment missing_user/)
  assert.throws(() => segmentIds('{"a":1}', 'google_user'), /không phải mảng/)
  assert.equal(MAX_NEW, 20)
})
