// server/store.js
// 数据存储：内存 + 同步落盘。Node 单线程模型下，同步的「检查-设置」即原子操作，
// 因此领取案件的并发抢占是安全的。
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function seed() {
  return {
    users: [
      { id: 'u-zhangwei', name: '张伟', employee_no: 'CL001' },
      { id: 'u-lina', name: '李娜', employee_no: 'CL002' },
      { id: 'u-wangqiang', name: '王强', employee_no: 'CL003' },
    ],
    policies: [
      {
        id: 'p-001',
        policy_number: 'PICC20240001',
        holder_name: '张伟',
        vehicle_plate: '京A12345',
        coverage: { 车损险: 100000, 三者险: 500000, 不计免赔: true },
        version: 1,
        updated_at: '2026-09-01T09:00:00.000Z',
      },
      {
        id: 'p-002',
        policy_number: 'PICC20240002',
        holder_name: '李娜',
        vehicle_plate: '京B67890',
        coverage: { 车损险: 80000, 三者险: 300000, 不计免赔: false },
        version: 1,
        updated_at: '2026-09-01T09:00:00.000Z',
      },
    ],
    cases: [
      {
        id: 'c-001',
        case_number: 'CAS20260928001',
        policy_id: 'p-001',
        status: 'pending', // pending | claimed | surveying | assessing | completed
        assigned_to: null,
        claimed_at: null,
        created_at: '2026-09-28T08:00:00.000Z',
        updated_at: '2026-09-28T08:00:00.000Z',
        version: 1,
      },
      {
        id: 'c-002',
        case_number: 'CAS20260928002',
        policy_id: 'p-002',
        status: 'pending',
        assigned_to: null,
        claimed_at: null,
        created_at: '2026-09-28T08:05:00.000Z',
        updated_at: '2026-09-28T08:05:00.000Z',
        version: 1,
      },
      {
        id: 'c-003',
        case_number: 'CAS20260927003',
        policy_id: 'p-001',
        status: 'surveying',
        assigned_to: 'u-wangqiang',
        claimed_at: '2026-09-27T10:00:00.000Z',
        created_at: '2026-09-27T09:00:00.000Z',
        updated_at: '2026-09-27T10:30:00.000Z',
        version: 3,
      },
    ],
    assessments: [
      {
        id: 'a-001',
        case_id: 'c-003',
        damage_parts: [
          { part: '前保险杠', amount: 2600 },
          { part: '左前大灯', amount: 1800 },
        ],
        estimated_total: 4400,
        assessed_amount: 4400,
        conclusion: '属于保险责任',
        policy_version: 1,
        valid: true,
        invalid_reason: null,
        recalculated: null,
        version: 1,
        history: [
          {
            version: 1,
            data: {
              damage_parts: [
                { part: '前保险杠', amount: 2600 },
                { part: '左前大灯', amount: 1800 },
              ],
              estimated_total: 4400,
              assessed_amount: 4400,
              conclusion: '属于保险责任',
            },
            updated_at: '2026-09-27T10:30:00.000Z',
            source: 'server',
          },
        ],
        created_at: '2026-09-27T10:30:00.000Z',
        updated_at: '2026-09-27T10:30:00.000Z',
      },
    ],
  };
}

let data = null;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    data = seed();
    save();
  }
  return data;
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function reset() {
  data = seed();
  save();
}

// ---- 领取案件：原子抢占 ----
function claimCase(caseId, userId) {
  const c = data.cases.find((x) => x.id === caseId);
  if (!c) return { error: 'not_found', message: '案件不存在' };
  if (c.assigned_to) {
    const u = data.users.find((x) => x.id === c.assigned_to);
    return {
      error: 'already_claimed',
      message: '该案件已被领取',
      claimed_by: u ? u.name : c.assigned_to,
      claimed_by_id: c.assigned_to,
      claimed_at: c.claimed_at,
    };
  }
  c.assigned_to = userId;
  c.claimed_at = new Date().toISOString();
  c.status = 'claimed';
  c.updated_at = c.claimed_at;
  c.version += 1;
  save();
  return { ok: true, case: clone(c) };
}

// ---- 案件流转 ----
const FLOW = ['pending', 'claimed', 'surveying', 'assessing', 'completed'];
function flowCase(caseId, userId) {
  const c = data.cases.find((x) => x.id === caseId);
  if (!c) return { error: 'not_found', message: '案件不存在' };
  if (c.assigned_to !== userId)
    return { error: 'forbidden', message: '只有领取人可以流转案件' };
  const idx = FLOW.indexOf(c.status);
  if (idx === -1 || idx === FLOW.length - 1)
    return { error: 'invalid_flow', message: '案件已在最终状态' };

  // 定损环节需要有效的定损结论
  if (c.status === 'surveying' || c.status === 'claimed') {
    const a = data.assessments.find((x) => x.case_id === caseId);
    if (a && !a.valid) {
      return {
        error: 'assessment_invalid',
        message: '定损结论已作废，不能流转。请重新确认重算后的定损结论。',
        invalid_reason: a.invalid_reason,
      };
    }
  }

  c.status = FLOW[idx + 1];
  c.updated_at = new Date().toISOString();
  c.version += 1;
  save();
  return { ok: true, case: clone(c) };
}

// ---- 保单更新：触发定损结论作废 + 重算 ----
function updatePolicy(policyId, patch) {
  const p = data.policies.find((x) => x.id === policyId);
  if (!p) return { error: 'not_found', message: '保单不存在' };
  if (patch.coverage) {
    p.coverage = { ...p.coverage, ...patch.coverage };
  }
  if (patch.holder_name !== undefined) p.holder_name = patch.holder_name;
  if (patch.vehicle_plate !== undefined) p.vehicle_plate = patch.vehicle_plate;
  p.version += 1;
  p.updated_at = new Date().toISOString();

  // 该保单下所有案件的定损结论作废并重算
  const affected = [];
  const cases = data.cases.filter((x) => x.policy_id === policyId);
  for (const c of cases) {
    const a = data.assessments.find((x) => x.case_id === c.id);
    if (!a) continue;
    a.valid = false;
    a.invalid_reason = `保单已更新至 v${p.version}，原定损结论自动作废`;
    // 自动重算
    const recalculated = recalculate(a, p);
    a.recalculated = recalculated;
    a.updated_at = p.updated_at;
    affected.push({ case_id: c.id, assessment_id: a.id });
  }
  save();
  return { ok: true, policy: clone(p), affected };
}

// 根据保单条款重算定损金额
function recalculate(assessment, policy) {
  const total = assessment.estimated_total;
  const coverage = policy.coverage || {};
  const chesun = coverage.车损险 || 0;
  const mianpei = coverage.不计免赔 ? 1 : 0.8;
  const assessed = Math.round(Math.min(total, chesun) * mianpei);
  return {
    assessed_amount: assessed,
    conclusion: assessed > 0 ? '属于保险责任' : '不属于保险责任',
    policy_version: policy.version,
    recalculated_at: new Date().toISOString(),
  };
}

// 确认重算结果，使结论重新有效
function confirmRecalculation(assessmentId) {
  const a = data.assessments.find((x) => x.id === assessmentId);
  if (!a) return { error: 'not_found', message: '定损不存在' };
  if (!a.recalculated) return { error: 'nothing', message: '没有待确认的重算结果' };
  a.assessed_amount = a.recalculated.assessed_amount;
  a.conclusion = a.recalculated.conclusion;
  a.policy_version = a.recalculated.policy_version;
  a.valid = true;
  a.invalid_reason = null;
  a.recalculated = null;
  a.version += 1;
  a.updated_at = new Date().toISOString();
  a.history.push({
    version: a.version,
    data: {
      damage_parts: clone(a.damage_parts),
      estimated_total: a.estimated_total,
      assessed_amount: a.assessed_amount,
      conclusion: a.conclusion,
    },
    updated_at: a.updated_at,
    source: 'recalculated',
  });
  save();
  return { ok: true, assessment: clone(a) };
}

// ---- 同步：离线变更合并 ----
// changes: [{ local_id, server_id, type, base_version, data, local_updated_at }]
function syncChanges(changes) {
  const results = [];
  for (const ch of changes) {
    if (ch.type === 'assessment') {
      results.push(syncAssessment(ch));
    } else if (ch.type === 'case') {
      results.push(syncCase(ch));
    }
  }
  save();
  return results;
}

function syncAssessment(ch) {
  const now = new Date().toISOString();
  // 新建
  if (!ch.server_id) {
    const id = 'a-' + Math.random().toString(36).slice(2, 8);
    const damageParts = ch.data.damage_parts || [];
    const estimatedTotal = ch.data.estimated_total || 0;
    // 根据保单条款重算
    const caseRec = data.cases.find((x) => x.id === ch.data.case_id);
    const policy = caseRec ? data.policies.find((p) => p.id === caseRec.policy_id) : null;
    let assessedAmount = ch.data.assessed_amount || 0;
    let conclusion = ch.data.conclusion || '属于保险责任';
    let policyVersion = ch.data.policy_version || 1;
    if (policy) {
      const r = recalculate(
        { estimated_total: estimatedTotal },
        policy
      );
      assessedAmount = r.assessed_amount;
      conclusion = r.conclusion;
      policyVersion = r.policy_version;
    }
    const a = {
      id,
      case_id: ch.data.case_id,
      damage_parts: damageParts,
      estimated_total: estimatedTotal,
      assessed_amount: assessedAmount,
      conclusion: conclusion,
      policy_version: policyVersion,
      valid: true,
      invalid_reason: null,
      recalculated: null,
      version: 1,
      history: [
        {
          version: 1,
          data: {
            damage_parts: clone(damageParts),
            estimated_total: estimatedTotal,
            assessed_amount: assessedAmount,
            conclusion: conclusion,
          },
          updated_at: ch.local_updated_at || now,
          source: 'local',
        },
      ],
      created_at: now,
      updated_at: ch.local_updated_at || now,
    };
    data.assessments.push(a);
    // 同步新建定损时，更新案件状态为查勘中
    if (caseRec && caseRec.status === 'claimed') {
      caseRec.status = 'surveying';
      caseRec.updated_at = now;
      caseRec.version += 1;
    }
    return {
      local_id: ch.local_id,
      server_id: id,
      status: 'synced',
      version: 1,
      assessment: clone(a),
    };
  }

  // 更新
  const a = data.assessments.find((x) => x.id === ch.server_id);
  if (!a)
    return { local_id: ch.local_id, status: 'error', message: '定损记录不存在' };

  if (ch.base_version === a.version) {
    // 无冲突，直接应用
    applyAssessment(a, ch.data);
    a.version += 1;
    a.updated_at = ch.local_updated_at || now;
    a.history.push({
      version: a.version,
      data: {
        damage_parts: clone(a.damage_parts),
        estimated_total: a.estimated_total,
        assessed_amount: a.assessed_amount,
        conclusion: a.conclusion,
      },
      updated_at: a.updated_at,
      source: 'local',
    });
    return {
      local_id: ch.local_id,
      server_id: a.id,
      status: 'synced',
      version: a.version,
      assessment: clone(a),
    };
  }

  // 冲突：两边都改过，按时间留两版
  const localVersion = {
    version: a.version + 1,
    data: {
      damage_parts: clone(ch.data.damage_parts || a.damage_parts),
      estimated_total: ch.data.estimated_total ?? a.estimated_total,
      assessed_amount: ch.data.assessed_amount ?? a.assessed_amount,
      conclusion: ch.data.conclusion || a.conclusion,
    },
    updated_at: ch.local_updated_at || now,
    source: 'local',
  };
  const serverVersion = {
    version: a.version,
    data: {
      damage_parts: clone(a.damage_parts),
      estimated_total: a.estimated_total,
      assessed_amount: a.assessed_amount,
      conclusion: a.conclusion,
    },
    updated_at: a.updated_at,
    source: 'server',
  };
  // 按时间排序，留两版
  const versions = [serverVersion, localVersion].sort(
    (x, y) => new Date(x.updated_at) - new Date(y.updated_at)
  );
  // 当前数据取最新时间的一版
  const latest = versions[versions.length - 1];
  a.damage_parts = clone(latest.data.damage_parts);
  a.estimated_total = latest.data.estimated_total;
  a.assessed_amount = latest.data.assessed_amount;
  a.conclusion = latest.data.conclusion;
  a.version = a.version + 1;
  a.updated_at = latest.updated_at;
  a.history = versions;
  return {
    local_id: ch.local_id,
    server_id: a.id,
    status: 'conflict',
    version: a.version,
    assessment: clone(a),
    versions: versions.map((v) => ({
      source: v.source,
      updated_at: v.updated_at,
      data: clone(v.data),
    })),
  };
}

function applyAssessment(a, d) {
  if (d.damage_parts !== undefined) a.damage_parts = clone(d.damage_parts);
  if (d.estimated_total !== undefined) a.estimated_total = d.estimated_total;
  if (d.assessed_amount !== undefined) a.assessed_amount = d.assessed_amount;
  if (d.conclusion !== undefined) a.conclusion = d.conclusion;
}

function syncCase(ch) {
  const now = new Date().toISOString();
  const c = data.cases.find((x) => x.id === ch.server_id);
  if (!c) return { local_id: ch.local_id, status: 'error', message: '案件不存在' };
  if (ch.base_version === c.version) {
    if (ch.data.status !== undefined) c.status = ch.data.status;
    if (ch.data.assigned_to !== undefined) c.assigned_to = ch.data.assigned_to;
    c.updated_at = ch.local_updated_at || now;
    c.version += 1;
    return {
      local_id: ch.local_id,
      server_id: c.id,
      status: 'synced',
      version: c.version,
      case: clone(c),
    };
  }
  // 案件冲突：同样按时间留两版
  const versions = [
    {
      source: 'server',
      updated_at: c.updated_at,
      data: { status: c.status, assigned_to: c.assigned_to },
    },
    {
      source: 'local',
      updated_at: ch.local_updated_at || now,
      data: {
        status: ch.data.status ?? c.status,
        assigned_to: ch.data.assigned_to ?? c.assigned_to,
      },
    },
  ].sort((x, y) => new Date(x.updated_at) - new Date(y.updated_at));
  const latest = versions[versions.length - 1];
  c.status = latest.data.status;
  c.assigned_to = latest.data.assigned_to;
  c.updated_at = latest.updated_at;
  c.version += 1;
  return {
    local_id: ch.local_id,
    server_id: c.id,
    status: 'conflict',
    version: c.version,
    case: clone(c),
    versions,
  };
}

module.exports = {
  get data() {
    return data;
  },
  load,
  save,
  reset,
  clone,
  claimCase,
  flowCase,
  updatePolicy,
  confirmRecalculation,
  syncChanges,
  recalculate,
};
