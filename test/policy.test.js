const test = require('node:test');
const assert = require('node:assert');
const { setupHarness } = require('./helpers');

test('保单更新：有效定损结论自动作废并按新条款重算', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' });
    await h.call('/api/cases/C-2026-1001/damage', {
      source: 'field', surveyor: '陈晨', parts: ['左后门'], estimate: 3000,
    });
    await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });

    // 初始：3000*0.8-500 = 1900
    const before = (await h.state()).cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(before.assessment.state, 'final');
    assert.strictEqual(before.assessment.payout, 1900);
    assert.strictEqual(before.assessment.basisPolicyVersion, 1);

    // 批改保单：比例降到 0.7，免赔升到 800
    const upd = await h.call('/api/policies/P-%E4%BA%ACA88888', {
      coverageRatio: 0.7, deductible: 800,
    });
    assert.strictEqual(upd.status, 200);
    assert.deepStrictEqual(upd.json.affectedCases, ['C-2026-1001']);

    const after = (await h.state()).cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(after.assessment.state, 'voided');
    assert.ok(after.assessment.voidReason.includes('v2'));
    // 3000*0.7-800 = 1300
    assert.strictEqual(after.assessment.recompute.payout, 1300);
    assert.strictEqual(after.assessment.recompute.basisPolicyVersion, 2);
    assert.strictEqual(after.status, 'claimed', '退回查勘中，不能带着过期结论流转');
  } finally {
    await h.stop();
  }
});

test('保单更新后，带过期结论的案件无法审批流转（409），重算确认后可以结案', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' });
    await h.call('/api/cases/C-2026-1001/damage', {
      source: 'field', surveyor: '陈晨', parts: ['左后门'], estimate: 3000,
    });
    await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });
    await h.call('/api/policies/P-%E4%BA%ACA88888', { coverageRatio: 0.7, deductible: 800 });

    // 尝试带着作废结论流转 → 拦截
    const blocked = await h.call('/api/cases/C-2026-1001/approve', {});
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.json.error, 'STALE_CONCLUSION');
    assert.ok(blocked.json.problems.some((p) => p.includes('作废')));

    // 复核重算结果并重新最终化 → 依据新保单 v2
    const fin2 = await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });
    assert.strictEqual(fin2.status, 200);
    assert.strictEqual(fin2.json.assessment.basisPolicyVersion, 2);
    assert.strictEqual(fin2.json.assessment.payout, 1300);

    const done = await h.call('/api/cases/C-2026-1001/approve', {});
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.json.status, 'approved');

    // 结案后保单再批改，不翻旧案
    await h.call('/api/policies/P-%E4%BA%ACA88888', { coverageRatio: 0.6, deductible: 1000 });
    const after = (await h.state()).cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(after.status, 'approved');
    assert.strictEqual(after.assessment.state, 'final');
  } finally {
    await h.stop();
  }
});

test('草稿/未定损案件不能流转；无车损不能最终化', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    // 未领取
    let r = await h.call('/api/cases/C-2026-1002/approve', {});
    assert.strictEqual(r.status, 409);
    assert.ok(r.json.problems.some((p) => p.includes('未领取')));

    await h.call('/api/cases/claim', { caseNo: 'C-2026-1002', surveyor: '周海' });
    // 已领取但无车损无结论
    r = await h.call('/api/cases/C-2026-1002/approve', {});
    assert.strictEqual(r.status, 409);
    assert.ok(r.json.problems.some((p) => p.includes('定损结论')));

    // 无车损不能最终化
    r = await h.call('/api/cases/C-2026-1002/finalize', { surveyor: '周海' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'NO_DAMAGE');

    // 草稿不能审批
    await h.call('/api/cases/C-2026-1002/damage', {
      source: 'ledger', parts: ['前保险杠'], estimate: 1000, editor: '内勤',
    });
    r = await h.call('/api/cases/C-2026-1002/approve', {});
    assert.strictEqual(r.status, 409);
    assert.ok(r.json.problems.some((p) => p.includes('草稿')));

    // 最终化后正常结案（P-京B66666: 1000*1.0-0 = 1000）
    await h.call('/api/cases/C-2026-1002/finalize', { surveyor: '周海' });
    r = await h.call('/api/cases/C-2026-1002/approve', {});
    assert.strictEqual(r.status, 200);
  } finally {
    await h.stop();
  }
});

test('保单批改校验：比例/免赔非法返回 400；不存在保单 404', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    let r = await h.call('/api/policies/P-xx', { coverageRatio: 0.5, deductible: 0 });
    assert.strictEqual(r.status, 404);
    r = await h.call('/api/policies/P-%E4%BA%ACA88888', { coverageRatio: 1.5, deductible: 0 });
    assert.strictEqual(r.status, 400);
    r = await h.call('/api/policies/P-%E4%BA%ACA88888', { coverageRatio: 0.8, deductible: -1 });
    assert.strictEqual(r.status, 400);
  } finally {
    await h.stop();
  }
});
