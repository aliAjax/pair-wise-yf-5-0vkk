const test = require('node:test');
const assert = require('node:assert');
const { setupHarness } = require('./helpers');

test('两人同时领取：只有先到者成功，后到者看到被谁领走', async () => {
  const h = await setupHarness();
  try {
    await h.reset();

    // 两个请求在同一个 tick 发出，服务端事务链决定先后
    const [r1, r2] = await Promise.all([
      h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' }),
      h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '周海' }),
    ]);

    const winner = r1.status === 200 ? r1 : r2;
    const loser = r1.status === 409 ? r1 : r2;

    assert.strictEqual(winner.status, 200);
    assert.strictEqual(winner.json.outcome, 'acquired');
    assert.strictEqual(loser.status, 409);
    assert.strictEqual(loser.json.outcome, 'lost');

    // 后到者必须明确看到案件被谁、何时领走
    assert.strictEqual(loser.json.claimedBy, winner.json.claimedBy);
    assert.ok(loser.json.claimedAt, '失败响应里必须带领取时间');
    assert.ok(['陈晨', '周海'].includes(loser.json.claimedBy));

    const s = await h.state();
    const c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.claimedBy, winner.json.claimedBy);
    assert.strictEqual(c.status, 'claimed');

    // 第三个查勘员再来，依然看到同样的归属信息
    const r3 = await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '王武' });
    assert.strictEqual(r3.status, 409);
    assert.strictEqual(r3.json.claimedBy, c.claimedBy);
  } finally {
    await h.stop();
  }
});

test('领取者本人重复领取是幂等成功（网络重试不会误报抢单失败）', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    const first = await h.call('/api/cases/claim', { caseNo: 'C-2026-1002', surveyor: '陈晨' });
    assert.strictEqual(first.status, 200);
    const again = await h.call('/api/cases/claim', { caseNo: 'C-2026-1002', surveyor: '陈晨' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.outcome, 'acquired');
    assert.strictEqual(again.json.idempotent, true);
  } finally {
    await h.stop();
  }
});

test('高并发抢单压测：200 个请求只有 1 个成功', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    const reqs = Array.from({ length: 200 }, (_, i) =>
      h.call('/api/cases/claim', { caseNo: 'C-2026-1003', surveyor: `查勘员${i}` })
    );
    const rs = await Promise.all(reqs);
    const wins = rs.filter((r) => r.status === 200 && !r.json.idempotent);
    const losses = rs.filter((r) => r.status === 409);
    assert.strictEqual(wins.length, 1, '必须恰有一人领取成功');
    assert.strictEqual(losses.length, 199);
    // 所有失败者指向同一个领取人
    assert.ok(losses.every((r) => r.json.claimedBy === wins[0].json.claimedBy));
  } finally {
    await h.stop();
  }
});

test('领取缺少参数返回 400', async () => {
  const h = await setupHarness();
  try {
    await h.reset();
    const r = await h.call('/api/cases/claim', { caseNo: 'C-2026-1001' });
    assert.strictEqual(r.status, 400);
  } finally {
    await h.stop();
  }
});
