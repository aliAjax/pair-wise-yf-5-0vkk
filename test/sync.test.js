const test = require('node:test');
const assert = require('node:assert');
const { setupHarness } = require('./helpers');

test('离线登记恢复网络后同步：版本保留、按时间排序、两边都改则两版并存', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' });

    // 1) 模拟现场在地下车库离线：两版登记（本地带真实登记时间）
    //    第一版 20 分钟前，第二版 10 分钟前
    const now = Date.now();
    const ops = [
      {
        type: 'damage',
        caseNo: 'C-2026-1001',
        clientId: 'field-1',
        surveyor: '陈晨',
        parts: ['左后门', '后保险杠'],
        estimate: 3000,
        note: '初勘',
        at: now - 1000 * 60 * 20,
      },
      {
        type: 'damage',
        caseNo: 'C-2026-1001',
        clientId: 'field-2',
        surveyor: '陈晨',
        parts: ['左后门', '后保险杠', '左后尾灯'],
        estimate: 3800,
        note: '复勘补拍尾灯损伤',
        at: now - 1000 * 60 * 10,
      },
    ];
    const sync1 = await h.call('/api/sync', { ops });
    assert.strictEqual(sync1.status, 200);
    assert.deepStrictEqual(sync1.json.results.map((r) => r.outcome), ['merged', 'merged']);

    let s = await h.state();
    let c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.damageVersions.length, 2);
    assert.deepStrictEqual(c.damageVersions.map((v) => v.clientId), ['field-1', 'field-2']);
    assert.ok(c.damageVersions[0].at <= c.damageVersions[1].at, '按登记时间升序');
    // 同步后应生成定损草稿
    assert.strictEqual(c.assessment.state, 'draft');
    assert.strictEqual(c.assessment.estimate, 3800);
    // P-京A88888: 3800*0.8-500 = 2540
    assert.strictEqual(c.assessment.payout, 2540);

    // 2) 公司台账侧在同一案件补录一版（时间 15 分钟前，夹在两版现场之间）
    const ledger = await h.call('/api/cases/C-2026-1001/damage', {
      source: 'ledger',
      parts: ['后保险杠'],
      estimate: 2000,
      editor: '内勤-赵芳',
      at: now - 1000 * 60 * 15,
    });
    assert.strictEqual(ledger.status, 200);

    s = await h.state();
    c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.damageVersions.length, 3, '两边都改过 → 三版全保留，不覆盖');
    const sources = c.damageVersions.map((v) => v.source);
    assert.deepStrictEqual(sources, ['field', 'ledger', 'field'], '按时间 interleaved 排列');

    // 3) 网络抖动导致同一批离线数据重放：clientId 幂等去重，不产生重复版本
    const replay = await h.call('/api/sync', { ops });
    assert.strictEqual(replay.status, 200);
    assert.ok(replay.json.results.every((r) => r.outcome === 'duplicate'));
    s = await h.state();
    c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.damageVersions.length, 3);

    // 4) 部分失败不影响其它条目，失败信息可定位
    const mixed = await h.call('/api/sync', {
      ops: [
        { type: 'damage', caseNo: 'C-2026-1001', clientId: 'field-3', parts: ['引擎盖'], estimate: 500 },
        { type: 'damage', caseNo: 'C-NO-SUCH', clientId: 'field-x', parts: ['引擎盖'], estimate: 500 },
      ],
    });
    assert.strictEqual(mixed.status, 200);
    assert.strictEqual(mixed.json.results[0].outcome, 'merged');
    assert.strictEqual(mixed.json.results[1].outcome, 'error');
    assert.strictEqual(mixed.json.results[1].error, 'CASE_NOT_FOUND');
  } finally {
    await h.stop();
  }
});

test('离线期间产生的新版本会使已最终化的定损结论作废，重算等待复核', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' });
    // 现场先登记并最终化
    await h.call('/api/cases/C-2026-1001/damage', {
      source: 'field', surveyor: '陈晨', parts: ['左后门'], estimate: 3000,
    });
    const fin = await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });
    assert.strictEqual(fin.status, 200);

    // 离线期间又登记了新损伤，联网同步
    const r = await h.call('/api/sync', {
      ops: [
        {
          type: 'damage', caseNo: 'C-2026-1001', clientId: 'offline-new',
          surveyor: '陈晨', parts: ['左后门', '后保险杠'], estimate: 5000,
          note: '举升后发现底大边变形', at: Date.now() + 1000,
        },
      ],
    });
    assert.strictEqual(r.status, 200);

    const s = await h.state();
    const c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.assessment.state, 'voided');
    assert.ok(c.assessment.voidReason.includes('离线'));
    // 重算值：5000*0.8-500 = 3500
    assert.strictEqual(c.assessment.recompute.payout, 3500);
    assert.strictEqual(c.status, 'claimed', '退回查勘中，不能继续往审批流');
  } finally {
    await h.stop();
  }
});
