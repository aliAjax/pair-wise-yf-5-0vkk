/**
 * 理赔查勘台 —— 服务端
 * 零外部依赖：Node 内置 http + JSON 文件原子写持久化。
 *
 * 业务规则：
 *  1. 派单(dispatched) → 领取(claimed)：领取是原子事务，两人同抢只有一人成功，
 *     败者拿到“被谁、何时领走”。
 *  2. 车损部位/估损金额以【版本】形式追加：现场离线版与公司台账版都保留，
 *     按时间排序，不做静默覆盖。
 *  3. 定损结论(final)若依赖的保单被更新，自动作废(voided)并按新条款重算，
 *     案件回落到“待复核”；带着过期结论流转(审批)会被 409 拦截。
 *  4. 所有写操作落盘（原子写：临时文件 + rename），重启不丢。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');

// ---------------------------------------------------------------------------
// 存储层：读/写 + 全局互斥（同一时刻只允许一个写事务，保证抢单原子性）
// ---------------------------------------------------------------------------

let writeChain = Promise.resolve();

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeDb(db) {
  const payload = JSON.stringify(db, null, 2);
  await fsp.mkdir(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, payload, 'utf8');
  await fsp.rename(tmp, DB_PATH); // 原子替换
}

/**
 * 串行化所有写事务。handler 拿到 db 的可变副本，返回响应数据；
 * handler 抛 HttpError 时不落盘，直接把错误返回给调用方。
 */
async function transaction(handler) {
  const run = writeChain.then(async () => {
    const db = readDb() || seed();
    const result = await handler(db);
    await writeDb(db);
    return result;
  });
  // 让链路即使本次失败也能继续接后续事务
  writeChain = run.then(() => {}, () => {});
  return run;
}

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// ---------------------------------------------------------------------------
// 初始化台账数据
// ---------------------------------------------------------------------------

function nowTs() {
  return Date.now();
}

function seed() {
  const t = nowTs() - 1000 * 60 * 60 * 26; // 保单大约在一天前更新过
  return {
    policies: {
      'P-京A88888': {
        policyNo: 'P-京A88888',
        plate: '京A88888',
        holder: '王磊',
        coverageRatio: 0.8, // 赔付比例
        deductible: 500,    // 每次事故免赔额（元）
        version: 1,
        updatedAt: t,
        history: [{ version: 1, coverageRatio: 0.8, deductible: 500, at: t }],
      },
      'P-京B66666': {
        policyNo: 'P-京B66666',
        plate: '京B66666',
        holder: '李静',
        coverageRatio: 1.0,
        deductible: 0,
        version: 1,
        updatedAt: t,
        history: [{ version: 1, coverageRatio: 1.0, deductible: 0, at: t }],
      },
    },
    cases: [
      {
        caseNo: 'C-2026-1001',
        plate: '京A88888',
        policyNo: 'P-京A88888',
        policyVersion: 1,
        title: '地库剐蹭——左后门/后保险杠',
        location: '朝阳·合生汇 B2 车库',
        status: 'dispatched', // dispatched → claimed → approved
        claimedBy: null,
        claimedAt: null,
        createdAt: nowTs() - 1000 * 60 * 90,
        damageVersions: [],
        assessment: null,
        // assessment 结构：
        // { state:'draft'|'final'|'voided', estimate, payout, basisPolicyVersion,
        //   finalizedBy, finalizedAt, voidReason, recompute }
        timeline: [],
      },
      {
        caseNo: 'C-2026-1002',
        plate: '京B66666',
        policyNo: 'P-京B66666',
        policyVersion: 1,
        title: '坡道溜车——前保险杠/右前翼子板',
        location: '海淀·中关村地下停车场',
        status: 'dispatched',
        claimedBy: null,
        claimedAt: null,
        createdAt: nowTs() - 1000 * 60 * 40,
        damageVersions: [],
        assessment: null,
        timeline: [],
      },
      {
        caseNo: 'C-2026-1003',
        plate: '京A88888',
        policyNo: 'P-京A88888',
        policyVersion: 1,
        title: '立柱碰撞——右后门凹陷',
        location: '西城·金融街 B3 车库',
        status: 'dispatched',
        claimedBy: null,
        claimedAt: null,
        createdAt: nowTs() - 1000 * 60 * 15,
        damageVersions: [],
        assessment: null,
        timeline: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 业务计算
// ---------------------------------------------------------------------------

function recomputePayout(db, caseItem, estimate) {
  const policy = db.policies[caseItem.policyNo];
  const payout = Math.max(0, Math.round(estimate * policy.coverageRatio - policy.deductible));
  return {
    estimate,
    payout,
    basisPolicyVersion: policy.version,
    formula: `估损 ${estimate} × 比例 ${policy.coverageRatio} − 免赔 ${policy.deductible} = ${payout}`,
  };
}

function getCase(db, caseNo) {
  const c = db.cases.find((x) => x.caseNo === caseNo);
  if (!c) throw new HttpError(404, 'CASE_NOT_FOUND', `案件 ${caseNo} 不存在`);
  return c;
}

function assertPolicyFresh(db, caseItem) {
  const policy = db.policies[caseItem.policyNo];
  if (!policy) throw new HttpError(422, 'POLICY_MISSING', '保单缺失，无法定损');
  return policy;
}

/**
 * 保单更新后调用：所有引用该保单、且持有“最终结论”的未结案案件全部作废重算。
 * 返回受影响案件号列表。
 */
function voidConclusionsForPolicy(db, policyNo, reason) {
  const affected = [];
  for (const c of db.cases) {
    if (c.policyNo !== policyNo) continue;
    if (c.status === 'approved') continue; // 已审批结案的不动
    const a = c.assessment;
    if (a && a.state === 'final') {
      a.state = 'voided';
      a.voidReason = reason;
      a.recompute = recomputePayout(db, c, a.estimate);
      c.status = 'claimed'; // 退回查勘员，不能带着过期结论继续流转
      c.timeline.push({
        at: nowTs(),
        type: 'assessment-voided',
        text: reason,
        by: 'system',
      });
      affected.push(c.caseNo);
    }
    // 草稿/未最终化的结论：保单版本基线前移，留待最终化时按新保单算
    if (c.policyVersion !== db.policies[policyNo].version) {
      c.policyVersion = db.policies[policyNo].version;
    }
  }
  return affected;
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  try {
    // ---- 台账全量视图（首页/恢复网络后拉取）----
    if (route === 'GET /api/state') {
      let db = readDb();
      if (!db) {
        db = seed();
        await writeDb(db); // 首次访问即落盘，保证“关掉再打开”台账一致
      }
      return send(200, { serverTime: nowTs(), policies: db.policies, cases: db.cases });
    }

    // ---- 重置演示数据 ----
    if (route === 'POST /api/reset') {
      const fresh = seed();
      await writeDb(fresh);
      return send(200, { ok: true });
    }

    // ---- 领取案件（抢单：原子事务）----
    if (route === 'POST /api/cases/claim') {
      const body = await readJson(req);
      const { caseNo, surveyor, at } = body;
      if (!caseNo || !surveyor) {
        throw new HttpError(400, 'BAD_REQUEST', 'caseNo 与 surveyor 必填');
      }
      const ts = at || nowTs();
      const result = await transaction((db) => {
        const c = getCase(db, caseNo);
        if (c.claimedBy === surveyor) {
          // 幂等：同一个人重复点领取，视为成功（现场网络重试场景）
          return {
            outcome: 'acquired',
            caseNo,
            claimedBy: c.claimedBy,
            claimedAt: c.claimedAt,
            idempotent: true,
          };
        }
        if (c.claimedBy) {
          // 抢单失败：必须告诉后来者被谁领走
          return {
            outcome: 'lost',
            caseNo,
            claimedBy: c.claimedBy,
            claimedAt: c.claimedAt,
          };
        }
        c.claimedBy = surveyor;
        c.claimedAt = ts;
        c.status = 'claimed';
        c.timeline.push({ at: ts, type: 'claimed', text: `查勘员 ${surveyor} 领取案件`, by: surveyor });
        return { outcome: 'acquired', caseNo, claimedBy: surveyor, claimedAt: ts };
      });
      return send(result.outcome === 'lost' ? 409 : 200, result);
    }

    // ---- 追加车损版本（现场离线回放 / 台账编辑 都走这里）----
    if (req.method === 'POST' && url.pathname.match(/^\/api\/cases\/[^/]+\/damage$/)) {
      const caseNo = url.pathname.split('/')[3];
      const body = await readJson(req);
      const { parts, estimate, source, surveyor, note, at, clientId } = body;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new HttpError(400, 'BAD_REQUEST', '至少登记一个车损部位');
      }
      if (typeof estimate !== 'number' || estimate < 0 || !Number.isFinite(estimate)) {
        throw new HttpError(400, 'BAD_REQUEST', '估损金额需为非负数字');
      }
      if (!source || !['field', 'ledger'].includes(source)) {
        throw new HttpError(400, 'BAD_REQUEST', "source 只能是 'field' 或 'ledger'");
      }
      const ts = at || nowTs();
      const result = await transaction((db) => {
        const c = getCase(db, caseNo);

        // 幂等：离线回放重试用 clientId 去重
        if (clientId && c.damageVersions.some((v) => v.clientId === clientId)) {
          return { outcome: 'duplicate', caseNo, versions: c.damageVersions };
        }

        const version = {
          id: randomUUID(),
          clientId: clientId || null,
          source, // field=现场离线登记, ledger=公司台账
          by: source === 'field' ? surveyor || c.claimedBy : body.editor || '台账员',
          parts,
          estimate,
          note: note || '',
          at: ts,
        };
        c.damageVersions.push(version);
        c.damageVersions.sort((a, b) => a.at - b.at);
        c.timeline.push({
          at: ts,
          type: 'damage',
          text: `${source === 'field' ? '现场' : '台账'}登记车损：${parts.join('、')}，估损 ${estimate} 元`,
          by: version.by,
        });

        // 结论联动：
        //  - 没有结论 → 生成草稿（按当前保单）
        //  - 草稿 → 用最新版本数据重算草稿
        //  - 最终结论 → 新证据出现，旧结论作废，回落待复核
        const policy = assertPolicyFresh(db, c);
        const calc = recomputePayout(db, c, estimate);
        if (!c.assessment || c.assessment.state === 'voided' || c.assessment.state === 'draft') {
          c.assessment = {
            state: 'draft',
            ...calc,
          };
        } else if (c.assessment.state === 'final') {
          c.assessment = {
            state: 'voided',
            ...(() => {
              const old = c.assessment;
              return {
                estimate: old.estimate,
                payout: old.payout,
                basisPolicyVersion: old.basisPolicyVersion,
                formula: old.formula,
                finalizedBy: old.finalizedBy,
                finalizedAt: old.finalizedAt,
              };
            })(),
            voidReason: '出现新的车损登记版本，原定损结论依据已变化，需复核重算',
            recompute: calc,
          };
          c.status = 'claimed';
          c.timeline.push({
            at: ts,
            type: 'assessment-voided',
            text: '新车损版本导致原结论作废',
            by: version.by,
          });
        }
        return { outcome: 'merged', caseNo, version, versions: c.damageVersions, assessment: c.assessment };
      });
      return send(200, result);
    }

    // ---- 离线批量同步：现场恢复网络后回放本地队列 ----
    if (route === 'POST /api/sync') {
      const body = await readJson(req);
      const ops = Array.isArray(body.ops) ? body.ops : [];
      const ts0 = nowTs();
      const results = [];
      // 全部排队进同一串行链，保证和台账侧编辑也互不覆盖
      for (const op of ops) {
        // eslint-disable-next-line no-await-in-loop
        const r = await transaction((db) => {
          const c = getCase(db, op.caseNo);
          if (op.type !== 'damage') {
            throw new HttpError(400, 'BAD_REQUEST', `未知同步操作类型: ${op.type}`);
          }
          if (op.clientId && c.damageVersions.some((v) => v.clientId === op.clientId)) {
            return { outcome: 'duplicate', caseNo: c.caseNo, clientId: op.clientId };
          }
          const ts = op.at || ts0;
          const version = {
            id: randomUUID(),
            clientId: op.clientId || null,
            source: 'field',
            by: op.surveyor || c.claimedBy,
            parts: op.parts,
            estimate: op.estimate,
            note: op.note || '（离线登记，联网后同步）',
            at: ts,
          };
          c.damageVersions.push(version);
          c.damageVersions.sort((a, b) => a.at - b.at);
          c.timeline.push({
            at: ts,
            type: 'damage',
            text: `现场离线登记：${op.parts.join('、')}，估损 ${op.estimate} 元`,
            by: version.by,
          });
          const policy = assertPolicyFresh(db, c);
          const calc = recomputePayout(db, c, op.estimate);
          if (!c.assessment || c.assessment.state === 'voided' || c.assessment.state === 'draft') {
            c.assessment = { state: 'draft', ...calc };
          } else if (c.assessment.state === 'final') {
            const old = c.assessment;
            c.assessment = {
              state: 'voided',
              estimate: old.estimate,
              payout: old.payout,
              basisPolicyVersion: old.basisPolicyVersion,
              formula: old.formula,
              finalizedBy: old.finalizedBy,
              finalizedAt: old.finalizedAt,
              voidReason: '现场离线期间产生新车损版本，原结论需复核重算',
              recompute: calc,
            };
            c.status = 'claimed';
            c.timeline.push({ at: ts, type: 'assessment-voided', text: '离线新版本导致原结论作废', by: version.by });
          }
          return { outcome: 'merged', caseNo: c.caseNo, clientId: op.clientId, version, assessment: c.assessment };
        }).catch((e) => ({
          outcome: 'error',
          caseNo: op.caseNo,
          clientId: op.clientId || null,
          error: e.code || 'ERROR',
          message: e.message,
        }));
        results.push(r);
      }
      const db = readDb();
      return send(200, { syncedAt: nowTs(), results, cases: db.cases });
    }

    // ---- 定损结论最终化（查勘员复核后确认重算结果）----
    if (req.method === 'POST' && url.pathname.match(/^\/api\/cases\/[^/]+\/finalize$/)) {
      const caseNo = url.pathname.split('/')[3];
      const body = await readJson(req);
      const result = await transaction((db) => {
        const c = getCase(db, caseNo);
        if (!c.claimedBy) throw new HttpError(409, 'NOT_CLAIMED', '案件尚未领取，不能定损');
        if (c.damageVersions.length === 0) {
          throw new HttpError(409, 'NO_DAMAGE', '尚无车损登记，不能出具定损结论');
        }
        const policy = assertPolicyFresh(db, c);
        if (c.assessment && c.assessment.state === 'voided') {
          // 作废后必须人工确认重算结果才允许重新最终化
          c.assessment = { state: 'draft', ...c.assessment.recompute };
        }
        if (c.assessment && c.assessment.state === 'final') {
          throw new HttpError(409, 'ALREADY_FINAL', '定损结论已是最终态');
        }
        // 永远以【最新车损版本 + 最新保单】计算，杜绝带着旧数据最终化
        const latest = [...c.damageVersions].sort((a, b) => b.at - a.at)[0];
        const calc = recomputePayout(db, c, latest.estimate);
        c.assessment = {
          state: 'final',
          ...calc,
          finalizedBy: body.surveyor || c.claimedBy,
          finalizedAt: nowTs(),
        };
        c.policyVersion = policy.version;
        c.timeline.push({
          at: nowTs(),
          type: 'finalized',
          text: `定损结论最终化：${c.assessment.formula}`,
          by: c.assessment.finalizedBy,
        });
        return { ok: true, caseNo, assessment: c.assessment };
      });
      return send(200, result);
    }

    // ---- 流转：审批结案（强校验，过期结论一律挡住）----
    if (req.method === 'POST' && url.pathname.match(/^\/api\/cases\/[^/]+\/approve$/)) {
      const caseNo = url.pathname.split('/')[3];
      const result = await transaction((db) => {
        const c = getCase(db, caseNo);
        const policy = db.policies[c.policyNo];
        const problems = [];
        if (!c.claimedBy) problems.push('案件未领取');
        if (!c.assessment) problems.push('没有定损结论');
        if (c.assessment && c.assessment.state !== 'final') {
          problems.push(
            c.assessment.state === 'voided'
              ? `定损结论已作废（${c.assessment.voidReason || ''}），必须按新保单重算并重新确认`
              : '定损结论仍是草稿，需最终化'
          );
        }
        if (c.assessment && c.assessment.state === 'final' && policy && c.assessment.basisPolicyVersion !== policy.version) {
          problems.push(
            `结论依据保单 v${c.assessment.basisPolicyVersion}，当前保单已到 v${policy.version}，结论过期`
          );
        }
        if (problems.length) {
          throw new HttpError(409, 'STALE_CONCLUSION', '案件不能带着过期/无效结论流转', {
            caseNo,
            problems,
            assessment: c.assessment,
            currentPolicyVersion: policy ? policy.version : null,
          });
        }
        c.status = 'approved';
        c.timeline.push({ at: nowTs(), type: 'approved', text: '审批通过，案件结案', by: 'approver' });
        return { ok: true, caseNo, status: c.status };
      });
      return send(200, result);
    }

    // ---- 保单更新（触发未结案件定损结论批量作废重算）----
    if (req.method === 'POST' && url.pathname.match(/^\/api\/policies\/[^/]+$/)) {
      const policyNo = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readJson(req);
      const result = await transaction((db) => {
        const p = db.policies[policyNo];
        if (!p) throw new HttpError(404, 'POLICY_NOT_FOUND', `保单 ${policyNo} 不存在`);
        const { coverageRatio, deductible } = body;
        if (typeof coverageRatio !== 'number' || !(coverageRatio > 0 && coverageRatio <= 1)) {
          throw new HttpError(400, 'BAD_REQUEST', '赔付比例需在 (0,1] 之间');
        }
        if (typeof deductible !== 'number' || deductible < 0) {
          throw new HttpError(400, 'BAD_REQUEST', '免赔额需为非负数');
        }
        p.version += 1;
        p.coverageRatio = coverageRatio;
        p.deductible = deductible;
        p.updatedAt = nowTs();
        p.history.push({ version: p.version, coverageRatio, deductible, at: p.updatedAt });

        const reason = `保单升级至 v${p.version}（比例 ${coverageRatio}，免赔 ${deductible}），原定损结论自动作废并重算`;
        const affected = voidConclusionsForPolicy(db, policyNo, reason);
        return { ok: true, policy: p, affectedCases: affected };
      });
      return send(200, result);
    }

    // ---- 静态文件 ----
    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }
    send(404, { error: 'NOT_FOUND' });
  } catch (e) {
    if (e instanceof HttpError) {
      return send(e.status, { error: e.code, message: e.message, ...e.extra });
    }
    console.error(e);
    send(500, { error: 'INTERNAL', message: e.message });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 1e6) reject(new HttpError(413, 'TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到页面');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INTERNAL', message: e.message }));
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`理赔查勘台已启动：http://localhost:${PORT}`);
  });
}

module.exports = { server, seed, readDb, writeDb, DB_PATH };
