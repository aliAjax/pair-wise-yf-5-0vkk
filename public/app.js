/* 理赔查勘台 —— 前端
 *
 * 离线策略：
 *  - “离线”开关（模拟地下车库无信号）：所有请求被拦截，车损登记进入本地队列；
 *  - 队列、表单草稿、当前查勘员、最近一次台账快照全部存 localStorage，
 *    关掉页面再打开可以继续；
 *  - 恢复在线后点“同步离线登记”，队列按顺序回放，服务端按 clientId 幂等去重；
 *  - 抢单必须在线（原子领取的前提就是服务端在场）。
 */
'use strict';

const LS = {
  surveyor: 'survey-console/surveyor',
  offline: 'survey-console/offline',
  queue: 'survey-console/queue',
  drafts: 'survey-console/drafts',
  lastSync: 'survey-console/lastSync',
  snapshot: 'survey-console/snapshot',
  tab: 'survey-console/tab',
};

const SURVEYORS = ['陈晨', '周海'];
const PART_OPTIONS = ['前保险杠', '后保险杠', '左前翼子板', '右前翼子板', '左后门', '右后门', '引擎盖', '行李箱盖', '左前大灯', '右前大灯'];

const state = {
  server: load(LS.snapshot, null),   // 最近一次服务端台账快照（离线时也能看）
  queue: load(LS.queue, []),
  drafts: load(LS.drafts, {}),
  surveyor: localStorage.getItem(LS.surveyor) || SURVEYORS[0],
  offline: localStorage.getItem(LS.offline) === '1',
  lastSync: load(LS.lastSync, null),
  tab: localStorage.getItem(LS.tab) || 'dispatch',
  raceResult: null,
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function persist() {
  localStorage.setItem(LS.queue, JSON.stringify(state.queue));
  localStorage.setItem(LS.drafts, JSON.stringify(state.drafts));
  localStorage.setItem(LS.snapshot, JSON.stringify(state.server));
  localStorage.setItem(LS.lastSync, JSON.stringify(state.lastSync));
  localStorage.setItem(LS.surveyor, state.surveyor);
  localStorage.setItem(LS.offline, state.offline ? '1' : '0');
  localStorage.setItem(LS.tab, state.tab);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const yuan = (n) => `${Number(n).toLocaleString('zh-CN')} 元`;

function toast(msg, kind = 'info', ms = 3800) {
  const host = document.getElementById('toastHost');
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = msg;
  host.appendChild(div);
  setTimeout(() => div.remove(), ms);
}

/** 带离线拦截的请求 */
async function api(pathname, opts = {}) {
  if (state.offline) {
    const err = new Error('OFFLINE');
    err.offline = true;
    throw err;
  }
  const res = await fetch(pathname, {
    method: opts.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function refresh() {
  if (state.offline) return; // 离线就用本地快照
  try {
    const data = await fetch('/api/state').then((r) => r.json());
    state.server = { serverTime: data.serverTime, policies: data.policies, cases: data.cases };
    state.lastSync = data.serverTime;
    persist();
  } catch (e) {
    toast(`拉取台账失败：${e.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 业务动作
// ---------------------------------------------------------------------------

async function claimCase(caseNo, surveyor) {
  if (state.offline) {
    toast('地下车库无信号，无法领取案件；领取必须联网由调度台确认。', 'error');
    return;
  }
  try {
    const r = await api('/api/cases/claim', { body: { caseNo, surveyor } });
    if (r.idempotent) toast(`案件 ${caseNo} 本来就是你领的（幂重确认）`, 'info');
    else toast(`领取成功：${caseNo}`, 'success');
    await refresh();
  } catch (e) {
    if (e.status === 409 && e.data) {
      const d = e.data;
      toast(`手慢一步！${caseNo} 已被 ${d.claimedBy} 于 ${fmtTime(d.claimedAt)} 领走`, 'error', 6000);
    } else {
      toast(`领取失败：${e.message}`, 'error');
    }
    await refresh();
  }
}

/** 两个人同时点领取：同一时刻发出两个请求，只有先到服务端事务的那个人成功 */
async function simulateRace(caseNo) {
  if (state.offline) {
    toast('离线状态无法演示抢单', 'error');
    return;
  }
  const [a, b] = SURVEYORS;
  const results = await Promise.allSettled([
    fetch('/api/cases/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseNo, surveyor: a }),
    }).then(async (r) => ({ surveyor: a, status: r.status, body: await r.json() })),
    fetch('/api/cases/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseNo, surveyor: b }),
    }).then(async (r) => ({ surveyor: b, status: r.status, body: await r.json() })),
  ]);
  state.raceResult = { caseNo, at: Date.now(), results: results.map((x) => x.value || x.reason) };
  await refresh();
  render();
}

function saveFieldDamage(caseNo) {
  const draft = state.drafts[caseNo];
  if (!draft || !draft.parts.length) {
    toast('请至少勾选一个车损部位', 'error');
    return;
  }
  if (!(draft.estimate > 0) || !Number.isFinite(Number(draft.estimate))) {
    toast('请填写有效的估损金额', 'error');
    return;
  }
  const op = {
    type: 'damage',
    caseNo,
    clientId: `${crypto.randomUUID()}`,
    surveyor: state.surveyor,
    parts: draft.parts,
    estimate: Number(draft.estimate),
    note: draft.note || '',
    at: Date.now(), // 离线期间的真实登记时间，合并排序靠它
  };

  if (state.offline) {
    state.queue.push(op);
    delete state.drafts[caseNo];
    persist();
    toast(`已存入本机离线队列（第 ${state.queue.length} 条），恢复网络后同步`, 'success', 5000);
    render();
    return;
  }
  // 在线：直接走单条登记接口（同样带 clientId 幂等）
  api(`/api/cases/${caseNo}/damage`, { body: op })
    .then(async (r) => {
      if (r.outcome === 'duplicate') toast('该登记已存在（幂等去重）', 'info');
      else toast('车损已登记并与公司台账合并', 'success');
      delete state.drafts[caseNo];
      await refresh();
      render();
    })
    .catch(async (e) => {
      toast(`登记失败：${e.message}，已转存离线队列`, 'error');
      state.queue.push(op);
      persist();
      render();
    });
}

async function syncQueue() {
  if (state.offline) {
    toast('当前仍是离线状态，请先切回在线再同步', 'error');
    return;
  }
  if (!state.queue.length) {
    toast('离线队列为空', 'info');
    return;
  }
  const ops = state.queue;
  try {
    const r = await api('/api/sync', { body: { ops } });
    const merged = r.results.filter((x) => x.outcome === 'merged').length;
    const dup = r.results.filter((x) => x.outcome === 'duplicate').length;
    const failed = r.results.filter((x) => x.outcome === 'error');
    // 幂等去重成功的也算“已落地”，从本地队列清掉；失败的保留待重试
    const landedIds = new Set(
      r.results.filter((x) => x.outcome === 'merged' || x.outcome === 'duplicate').map((x) => x.clientId)
    );
    state.queue = state.queue.filter((op) => !landedIds.has(op.clientId));
    state.lastSync = r.syncedAt;
    persist();
    await refresh();
    let msg = `同步完成：新合并 ${merged} 条` + (dup ? `，幂等去重 ${dup} 条` : '');
    toast(msg, failed.length ? 'error' : 'success', 5000);
    if (failed.length) toast(`${failed.length} 条失败保留在队列：${failed.map((f) => f.message).join('；')}`, 'error', 7000);
    render();
  } catch (e) {
    toast(`同步失败：${e.message}，队列已保留`, 'error');
  }
}

async function finalize(caseNo) {
  try {
    await api(`/api/cases/${caseNo}/finalize`, { body: { surveyor: state.surveyor } });
    toast('定损结论已最终化（按最新车损与最新保单计算）', 'success');
    await refresh();
    render();
  } catch (e) {
    toast(`最终化失败：${e.message}`, 'error');
  }
}

async function approve(caseNo) {
  try {
    await api(`/api/cases/${caseNo}/approve`, {});
    toast(`${caseNo} 审批通过，已结案`, 'success');
    await refresh();
    render();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.problems) {
      toast(`流转被拦截：${e.data.problems.join('；')}`, 'error', 8000);
    } else {
      toast(`审批失败：${e.message}`, 'error');
    }
    await refresh();
    render();
  }
}

async function ledgerEdit(caseNo) {
  const parts = document.getElementById(`ledger-parts-${caseNo}`).value
    .split(/[，,\s]+/).filter(Boolean);
  const estimate = Number(document.getElementById(`ledger-est-${caseNo}`).value);
  const editor = document.getElementById(`ledger-editor-${caseNo}`).value.trim() || '台账员';
  if (!parts.length || !(estimate >= 0)) {
    toast('台账登记需要部位和有效金额', 'error');
    return;
  }
  try {
    await api(`/api/cases/${caseNo}/damage`, {
      body: { source: 'ledger', parts, estimate, editor, at: Date.now() },
    });
    toast('台账已更新；若现场也改过，将与现场版并列保留', 'success');
    await refresh();
    render();
  } catch (e) {
    toast(`台账更新失败：${e.message}`, 'error');
  }
}

async function updatePolicy(policyNo) {
  const coverageRatio = Number(document.getElementById(`pol-ratio-${policyNo}`).value);
  const deductible = Number(document.getElementById(`pol-ded-${policyNo}`).value);
  try {
    const r = await api(`/api/policies/${encodeURIComponent(policyNo)}`, {
      body: { coverageRatio, deductible },
    });
    if (r.affectedCases.length) {
      toast(`保单已升级到 v${r.policy.version}：${r.affectedCases.length} 个案件的定损结论自动作废，等待重算`, 'error', 7000);
    } else {
      toast(`保单已升级到 v${r.policy.version}，当前没有在途的最终结论受影响`, 'success');
    }
    await refresh();
    render();
  } catch (e) {
    toast(`保单更新失败：${e.message}`, 'error');
  }
}

async function resetAll() {
  if (!confirm('确定重置全部演示数据？本地离线队列与草稿也会清空。')) return;
  await api('/api/reset', {});
  state.queue = [];
  state.drafts = {};
  state.raceResult = null;
  state.lastSync = Date.now();
  persist();
  await refresh();
  toast('演示数据已重置', 'success');
  render();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const $main = document.getElementById('main');

function caseById(caseNo) {
  return state.server?.cases?.find((c) => c.caseNo === caseNo);
}

function render() {
  persist();
  // 顶栏状态
  document.getElementById('offlineToggle').checked = state.offline;
  document.getElementById('offlineLabel').textContent = state.offline ? '离线（无信号）' : '在线';
  document.getElementById('syncBtn').disabled = state.offline;
  const badge = document.getElementById('queueBadge');
  if (state.queue.length) {
    badge.classList.remove('hidden');
    badge.textContent = `离线 ${state.queue.length}`;
  } else badge.classList.add('hidden');
  document.getElementById('lastSync').textContent =
    state.lastSync ? `台账更新于 ${fmtTime(state.lastSync)}` : '尚未同步';

  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const banner = document.getElementById('globalOfflineBanner');
  if (state.offline && !banner) {
    const b = document.createElement('div');
    b.id = 'globalOfflineBanner';
    b.className = 'offline-banner';
    b.textContent = '📵 离线模式（模拟地下车库）：车损登记保存在本机，恢复网络后同步；抢单与审批需联网。';
    document.body.insertBefore(b, document.querySelector('.tabs'));
  } else if (!state.offline && banner) {
    banner.remove();
  }

  const fn = { dispatch: renderDispatch, field: renderField, assess: renderAssess, ledger: renderLedger }[state.tab];
  $main.innerHTML = '';
  fn();
}

function caseCard(c) {
  const statusText = { dispatched: '待领取', claimed: '查勘中', approved: '已结案' }[c.status];
  const mine = c.claimedBy === state.surveyor;
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>${esc(c.caseNo)} · ${esc(c.title)}</h3>
        <span class="status ${c.status}">${statusText}</span>
      </div>
      <div class="sub">车牌 ${esc(c.plate)} ｜ 保单 ${esc(c.policyNo)} ｜ ${esc(c.location)} ｜ 派单 ${fmtTime(c.createdAt)}</div>
      ${c.claimedBy
        ? `<div class="kv">领取人：<b>${esc(c.claimedBy)}</b>（${fmtTime(c.claimedAt)}）${mine ? ' · 是你' : ''}</div>`
        : `<div class="row" style="margin-top:10px">
             <button class="btn primary" onclick="claimCase('${c.caseNo}','${esc(state.surveyor)}')">我（${esc(state.surveyor)}）领取</button>
             <button class="btn" onclick="simulateRace('${c.caseNo}')">⚡ 模拟两人同时领取（${esc(SURVEYORS.join(' vs '))}）</button>
           </div>
           <div class="sub" style="margin-top:6px">可切换右上角查勘员身份，或用“同时领取”直接观察抢单失败者看到的提示。</div>`}
    </div>`;
}

function renderDispatch() {
  const cases = state.server?.cases || [];
  let html = '';
  if (state.raceResult) {
    const winner = state.raceResult.results.find((r) => r.status === 200 && r.body.outcome === 'acquired' && !r.body.idempotent);
    const loser = state.raceResult.results.find((r) => r.status === 409);
    html += `<div class="card" style="border-color:#f59e0b">
      <h3>抢单结果（${esc(state.raceResult.caseNo)}，两个请求同批发出）</h3>
      <div class="grid2" style="margin-top:8px">
        <div class="policy-box" style="border-color:#86efac">
          <div class="kv">✅ 先到者：<b>${esc(winner?.surveyor)}</b></div>
          <div class="kv">服务端返回 200 acquired，时间 ${winner ? fmtTime(winner.body.claimedAt) : '-'}</div>
        </div>
        <div class="policy-box" style="border-color:#fca5a5">
          <div class="kv">⛔ 后到者：<b>${esc(loser?.surveyor)}</b></div>
          <div class="kv">服务端返回 409 lost，明确告知：案件已被 <b>${esc(loser?.body.claimedBy)}</b> 于 ${loser ? fmtTime(loser.body.claimedAt) : '-'} 领走</div>
        </div>
      </div>
    </div>`;
  }
  html += cases.filter((c) => c.status === 'dispatched').map(caseCard).join('')
    || '<div class="card">暂无可领取的新案件。</div>';
  html += '<h3 style="margin:18px 0 8px">进行中 / 已结案</h3>';
  html += cases.filter((c) => c.status !== 'dispatched').map(caseCard).join('');
  $main.innerHTML = html;
}

function renderVersions(c) {
  if (!c.damageVersions.length) return '<div class="sub">暂无车损登记。</div>';
  const sources = new Set(c.damageVersions.map((v) => v.source));
  let banner = '';
  if (sources.has('field') && sources.has('ledger')) {
    banner = `<div class="conflict-banner">⚠ 同一案件现场与公司台账两边都改过：已按登记时间保留 <b>${c.damageVersions.length}</b> 个版本，不互相覆盖；定损以最新时间版本为准，原最终结论已作废待复核。</div>`;
  }
  const rows = [...c.damageVersions].sort((a, b) => b.at - a.at).map((v) => `
    <div class="vrow">
      <div>
        <span class="chip ${v.source}">${v.source === 'field' ? '现场登记' : '公司台账'}</span>
        <div class="parts" style="margin-top:4px">${esc(v.parts.join('、'))}</div>
        <div class="sub" style="margin:2px 0 0">${esc(v.note || '')}</div>
      </div>
      <div class="meta">
        估损 <b>${yuan(v.estimate)}</b><br/>
        ${esc(v.by)} · ${fmtTime(v.at)}
      </div>
    </div>`).join('');
  return banner + `<div class="versions">${rows}</div>`;
}

function renderField() {
  const cases = (state.server?.cases || []).filter((c) => c.claimedBy === state.surveyor && c.status !== 'approved');
  if (!cases.length) {
    $main.innerHTML = '<div class="card">你名下没有进行中的案件，先去「派单领取」领一件。</div>';
    return;
  }
  let html = '';
  for (const c of cases) {
    const d = state.drafts[c.caseNo] || { parts: [], estimate: '', note: '' };
    const pending = state.queue.filter((op) => op.caseNo === c.caseNo);
    html += `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>${esc(c.caseNo)} · ${esc(c.title)}</h3>
        <span class="status claimed">查勘中</span>
      </div>
      <div class="sub">${esc(c.location)} ｜ 离线时可照常登记，数据只进本机队列</div>

      <label class="fld">车损部位（可多选）
        <div class="row" style="margin-top:6px">
          ${PART_OPTIONS.map((p) => `
            <label style="font-size:13px;white-space:nowrap">
              <input type="checkbox" data-case="${esc(c.caseNo)}" data-part="${esc(p)}" ${d.parts.includes(p) ? 'checked' : ''}/> ${esc(p)}
            </label>`).join('')}
        </div>
      </label>
      <div class="grid2">
        <label class="fld">估损金额（元）
          <input type="number" min="0" step="1" data-case-est="${esc(c.caseNo)}" value="${esc(d.estimate)}" placeholder="如 3200"/>
        </label>
        <label class="fld">备注
          <input type="text" data-case-note="${esc(c.caseNo)}" value="${esc(d.note)}" placeholder="如 地库立柱剐蹭，已拍照 12 张"/>
        </label>
      </div>
      <div class="row">
        <button class="btn primary" onclick="saveFieldDamage('${esc(c.caseNo)}')">${state.offline ? '📵 离线保存到本机' : '保存车损登记'}</button>
        ${pending.length ? `<span class="chip draft">本机待同步 ${pending.length} 条（${pending.map((p) => fmtTime(p.at).slice(6)).join('、')}）</span>` : ''}
      </div>
      ${state.offline ? '<div class="damage-badge-note">当前无信号：该登记不会离开这台设备，关掉页面也不丢；联网后点右上角“同步离线登记”。</div>' : ''}

      <h4 style="margin:14px 0 4px">车损版本（现场版 / 台账版按时间合并）</h4>
      ${renderVersions(c)}
      ${renderAssessmentBlock(c, false)}
    </div>`;
  }
  $main.innerHTML = html;
  bindDraftInputs(cases.map((c) => c.caseNo));
}

function bindDraftInputs(caseNos) {
  for (const caseNo of caseNos) {
    state.drafts[caseNo] = state.drafts[caseNo] || { parts: [], estimate: '', note: '' };
    document.querySelectorAll(`input[data-case="${caseNo}"]`).forEach((cb) => {
      cb.addEventListener('change', () => {
        const d = state.drafts[caseNo];
        const part = cb.dataset.part;
        d.parts = d.parts.filter((x) => x !== part);
        if (cb.checked) d.parts.push(part);
        persist();
      });
    });
    const est = document.querySelector(`[data-case-est="${caseNo}"]`);
    est?.addEventListener('input', () => { state.drafts[caseNo].estimate = est.value; persist(); });
    const note = document.querySelector(`[data-case-note="${caseNo}"]`);
    note?.addEventListener('input', () => { state.drafts[caseNo].note = note.value; persist(); });
  }
}

function assessmentStateChip(a) {
  if (!a) return '<span class="chip draft">未定损</span>';
  const map = { draft: '草稿（未最终化）', final: '最终结论（有效）', voided: '已作废（待重算确认）' };
  return `<span class="chip ${a.state}">${map[a.state]}</span>`;
}

function renderAssessmentBlock(c, withActions) {
  const a = c.assessment;
  let body;
  if (!a) {
    body = '<div class="sub">登记车损后自动生成定损草稿。</div>';
  } else if (a.state === 'voided') {
    body = `
      <div class="void-banner">
        ⛔ 原定损结论已作废：${esc(a.voidReason || '依据发生变化')}<br/>
        原结论（保单 v${esc(a.basisPolicyVersion)}）：${yuan(a.estimate)} → 赔付 <b>${yuan(a.payout)}</b>
      </div>
      <div class="policy-box">
        <div class="kv"><b>系统按新依据重算：</b>${esc(a.recompute.formula)}</div>
        <div class="kv">重算赔付：<b style="color:#991b1b">${yuan(a.recompute.payout)}</b>（基于保单 v${esc(a.recompute.basisPolicyVersion)}）</div>
      </div>
      ${withActions ? `<button class="btn success" style="margin-top:8px" onclick="finalize('${esc(c.caseNo)}')">复核无误，确认重算并最终化</button>` : ''}`;
  } else {
    body = `
      <div class="kv">${esc(a.formula)}</div>
      <div class="kv">估损 ${yuan(a.estimate)} ｜ 建议赔付 <b>${yuan(a.payout)}</b> ｜ 依据保单 v${esc(a.basisPolicyVersion)}
        ${a.finalizedAt ? `｜ 最终化：${esc(a.finalizedBy)} · ${fmtTime(a.finalizedAt)}` : ''}</div>
      ${withActions && a.state === 'draft' ? `<button class="btn success" style="margin-top:8px" onclick="finalize('${esc(c.caseNo)}')">定损结论最终化</button>` : ''}`;
  }
  return `<div style="margin-top:12px"><div class="row">${assessmentStateChip(a)}</div>${body}</div>`;
}

function renderAssess() {
  const cases = (state.server?.cases || []).filter((c) => c.status !== 'approved' && c.claimedBy);
  if (!cases.length) {
    $main.innerHTML = '<div class="card">没有在途案件。</div>';
    return;
  }
  $main.innerHTML = cases.map((c) => `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>${esc(c.caseNo)} · ${esc(c.title)}</h3>
        <span>查勘员：<b>${esc(c.claimedBy)}</b></span>
      </div>
      ${renderAssessmentBlock(c, true)}
      <div class="row" style="margin-top:12px">
        <button class="btn ${c.assessment?.state === 'final' ? 'primary' : ''}"
                onclick="approve('${esc(c.caseNo)}')"
                ${c.assessment?.state !== 'final' ? 'title="只有有效最终结论才能流转"' : ''}>
          提交审批结案
        </button>
        ${c.assessment?.state !== 'final'
          ? '<span class="sub">过期/作废/草稿状态下点击会被服务端 409 拦截，并返回具体原因。</span>'
          : '<span class="sub">服务端会再次校验结论依据的保单版本是否仍为最新。</span>'}
      </div>
      <details style="margin-top:10px">
        <summary class="sub" style="cursor:pointer">案件时间线（${c.timeline.length}）</summary>
        <ul class="timeline">
          ${[...c.timeline].sort((x, y) => y.at - x.at).map((t) => `
            <li><span class="t-time">${fmtTime(t.at)}</span>${esc(t.text)} <span class="muted">— ${esc(t.by)}</span></li>`).join('')}
        </ul>
      </details>
    </div>`).join('');
}

function renderLedger() {
  const policies = Object.values(state.server?.policies || {});
  const cases = state.server?.cases || [];
  let html = '<div class="grid2">';

  html += '<div>';
  for (const p of policies) {
    html += `<div class="card">
      <h3>保单 ${esc(p.policyNo)} <span class="sub">（${esc(p.plate)} · ${esc(p.holder)}）</span></h3>
      <div class="kv">当前版本：<b>v${p.version}</b>（更新于 ${fmtTime(p.updatedAt)}）</div>
      <div class="kv">赔付比例 <b>${p.coverageRatio}</b> ｜ 每次免赔 <b>${yuan(p.deductible)}</b></div>
      <div class="grid2" style="margin-top:8px">
        <label class="fld">新赔付比例（0~1）
          <input id="pol-ratio-${esc(p.policyNo)}" type="number" step="0.05" min="0.05" max="1" value="${p.coverageRatio}"/>
        </label>
        <label class="fld">新免赔额（元）
          <input id="pol-ded-${esc(p.policyNo)}" type="number" min="0" step="50" value="${p.deductible}"/>
        </label>
      </div>
      <button class="btn danger" onclick="updatePolicy('${esc(p.policyNo)}')">保单批改 → 自动作废在途定损结论</button>
      <details class="sub" style="margin-top:8px"><summary style="cursor:pointer">批改历史</summary>
        <ul class="timeline">${p.history.map((h) => `<li><span class="t-time">${fmtTime(h.at)}</span>v${h.version}：比例 ${h.coverageRatio}，免赔 ${h.deductible}</li>`).join('')}</ul>
      </details>
    </div>`;
  }
  html += '</div><div>';

  html += '<div class="card"><h3>公司台账侧车损补录</h3><div class="sub">模拟回公司后内勤在台账上修改同一案件；若现场离线也改过，两边版本并列保留。</div></div>';
  for (const c of cases.filter((x) => x.claimedBy)) {
    html += `<div class="card">
      <h3>${esc(c.caseNo)}</h3>
      <div class="grid2">
        <label class="fld">车损部位（逗号分隔）
          <input id="ledger-parts-${esc(c.caseNo)}" placeholder="前保险杠,左前大灯"/>
        </label>
        <label class="fld">估损金额（元）
          <input id="ledger-est-${esc(c.caseNo)}" type="number" min="0"/>
        </label>
      </div>
      <label class="fld">台账登记人
        <input id="ledger-editor-${esc(c.caseNo)}" value="内勤-赵芳"/>
      </label>
      <button class="btn" onclick="ledgerEdit('${esc(c.caseNo)}')">写入台账版本</button>
      <details style="margin-top:8px" open>
        <summary class="sub" style="cursor:pointer">现有版本 ${c.damageVersions.length} 条 / 时间线 ${c.timeline.length} 条</summary>
        <div style="margin-top:6px">${renderVersions(c)}</div>
      </details>
    </div>`;
  }
  html += '</div></div>';
  $main.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function init() {
  // 查勘员选择
  const sel = document.getElementById('surveyor');
  sel.innerHTML = SURVEYORS.map((s) => `<option ${s === state.surveyor ? 'selected' : ''}>${s}</option>`).join('');
  sel.addEventListener('change', () => { state.surveyor = sel.value; render(); });

  document.getElementById('offlineToggle').addEventListener('change', async (e) => {
    state.offline = e.target.checked;
    persist();
    if (!state.offline) {
      await refresh();
      toast('网络已恢复，台账已刷新；点“同步离线登记”回放本机队列', 'success', 5000);
    } else {
      toast('已切换离线：后续登记保存在本机', 'info');
    }
    render();
  });
  document.getElementById('syncBtn').addEventListener('click', syncQueue);
  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); });
  });

  window.addEventListener('online', () => toast('浏览器报告网络已恢复', 'info'));

  render();
  refresh().then(() => {
    lastServerSig = serverSignature();
    render();
  });
  // 每 8 秒轮询一次（在线时），方便开两个浏览器窗口观察抢单/保单批改联动；
  // 台账无变化时跳过重绘，避免打断正在填写的离线表单。
  setInterval(async () => {
    if (state.offline) return;
    await refresh();
    const sig = serverSignature();
    if (sig !== lastServerSig) {
      lastServerSig = sig;
      render();
    }
  }, 8000);
}

// 供内联事件调用
Object.assign(window, {
  claimCase, simulateRace, saveFieldDamage, finalize, approve, ledgerEdit, updatePolicy,
});

// 台账内容签名：只用于判断轮询结果是否值得一次重绘
let lastServerSig = null;
function serverSignature() {
  if (!state.server) return '';
  // 注意：不要把 serverTime 纳入签名（每次轮询都变）
  return JSON.stringify({
    c: state.server.cases.map((c) => [
      c.caseNo, c.status, c.claimedBy, c.damageVersions.length,
      c.assessment?.state, c.assessment?.basisPolicyVersion, c.timeline.length,
    ]),
    p: Object.values(state.server.policies).map((p) => [p.policyNo, p.version]),
  });
}

init();
