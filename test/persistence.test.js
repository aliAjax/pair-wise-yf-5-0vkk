const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 持久化验证：服务进程“关掉再打开”，
 * 案件领取归属、车损版本、作废状态、保单版本全部从磁盘恢复。
 * 这里通过关闭 server、清模块缓存、重新 require 来模拟进程重启，
 * 数据库文件路径保持不变。
 */
async function startAgainst(dbPath) {
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../server.js')];
  const { server } = require('../server.js');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = async (p, body, method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const state = async () => (await call('/api/state', undefined, 'GET')).json;
  const stop = () => new Promise((r) => server.close(r));
  return { call, state, stop };
}

test('服务重启后：领取归属、车损版本、作废结论、保单批改全部保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-persist-'));
  const dbPath = path.join(dir, 'db.json');

  let h = await startAgainst(dbPath);
  try {
    await h.call('/api/reset', {});
    await h.call('/api/cases/claim', { caseNo: 'C-2026-1001', surveyor: '陈晨' });
    await h.call('/api/cases/C-2026-1001/damage', {
      source: 'field', surveyor: '陈晨', parts: ['左后门', '后保险杠'], estimate: 3000,
    });
    await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });
    await h.call('/api/policies/P-%E4%BA%ACA88888', { coverageRatio: 0.7, deductible: 800 });

    const before = (await h.state()).cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(before.assessment.state, 'voided');
    assert.strictEqual(before.claimedBy, '陈晨');
    assert.ok(fs.existsSync(dbPath), '数据必须已落盘');
  } finally {
    await h.stop();
  }

  // —— 模拟“关掉再打开”：全新模块实例，同一份数据文件 ——
  h = await startAgainst(dbPath);
  try {
    const s = await h.state();
    const c = s.cases.find((x) => x.caseNo === 'C-2026-1001');
    assert.strictEqual(c.claimedBy, '陈晨', '领取归属保留');
    assert.strictEqual(c.status, 'claimed');
    assert.strictEqual(c.damageVersions.length, 1);
    assert.deepStrictEqual(c.damageVersions[0].parts, ['左后门', '后保险杠']);
    assert.strictEqual(c.assessment.state, 'voided', '作废状态保留，不会带着过期结论复活');
    assert.strictEqual(c.assessment.recompute.payout, 1300);
    assert.strictEqual(s.policies['P-京A88888'].version, 2);

    // 重启后依然不能带着旧结论流转，必须重算确认
    const blocked = await h.call('/api/cases/C-2026-1001/approve', {});
    assert.strictEqual(blocked.status, 409);
    await h.call('/api/cases/C-2026-1001/finalize', { surveyor: '陈晨' });
    const done = await h.call('/api/cases/C-2026-1001/approve', {});
    assert.strictEqual(done.status, 200);
  } finally {
    await h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
