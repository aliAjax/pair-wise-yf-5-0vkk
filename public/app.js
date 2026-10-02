// public/app.js
// 理赔查勘台 主应用
(function () {
  'use strict';

  const state = {
    user: null,
    users: [],
    cases: [],
    policies: [],
    online: navigator.onLine,
    manualOffline: false,
    currentCaseLocalId: null,
    currentTab: 'cases',
    syncing: false,
  };

  // ---- 工具 ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&', '<': '<', '>': '>', '"': '"', "'": "'",
    }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtMoney(n) {
    return '¥' + (n || 0).toLocaleString('zh-CN');
  }

  function isOnline() {
    return state.online && !state.manualOffline;
  }

  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + type;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---- 初始化 ----
  async function init() {
    await DB.openDB();
    const savedUserId = localStorage.getItem('claims_user_id');
    if (savedUserId) {
      const users = await DB.getAllUsers ? await DB.getAllUsers() : [];
      // 从缓存或服务端获取用户
      let user = users.find((u) => u.id === savedUserId);
      if (!user) {
        try {
          const resp = await fetch('/api/users');
          if (resp.ok) {
            const list = await resp.json();
            await DB.cacheUsers(list);
            user = list.find((u) => u.id === savedUserId);
          }
        } catch (e) { /* offline */ }
      }
      if (user) {
        state.user = user;
        await enterApp();
      } else {
        showLogin();
      }
    } else {
      showLogin();
    }

    // 监听网络状态
    window.addEventListener('online', () => {
      state.online = true;
      updateNetBadge();
      if (!state.manualOffline) doSync();
    });
    window.addEventListener('offline', () => {
      state.online = false;
      updateNetBadge();
    });

    // 注册 Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  function showLogin() {
    $('#login-screen').classList.remove('hidden');
    $('#app-screen').classList.add('hidden');
    renderUserList();
  }

  async function renderUserList() {
    let users = [];
    try {
      const resp = await fetch('/api/users');
      if (resp.ok) {
        users = await resp.json();
        await DB.cacheUsers(users);
      }
    } catch (e) {
      users = await DB.getAllUsers ? await DB.getAllUsers() : [];
    }
    state.users = users;
    const list = $('#user-list');
    list.innerHTML = users.map((u) => `
      <div class="user-option" data-id="${esc(u.id)}">
        <div class="user-avatar">${esc(u.name[0])}</div>
        <div>
          <div class="user-name">${esc(u.name)}</div>
          <div class="user-no">${esc(u.employee_no)}</div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.user-option').forEach((el) => {
      el.addEventListener('click', () => selectUser(el.dataset.id));
    });
  }

  async function selectUser(userId) {
    const user = state.users.find((u) => u.id === userId);
    if (!user) return;
    state.user = user;
    localStorage.setItem('claims_user_id', userId);
    await enterApp();
  }

  async function enterApp() {
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    $('#current-user').textContent = state.user.name;
    updateNetBadge();
    await loadData();
    renderAll();
    if (isOnline()) doSync();
  }

  async function logout() {
    localStorage.removeItem('claims_user_id');
    state.user = null;
    showLogin();
  }

  // ---- 数据加载 ----
  async function loadData() {
    if (isOnline()) {
      try {
        await Sync.pullServerData();
      } catch (e) {
        console.warn('拉取服务端数据失败，使用本地缓存', e);
      }
    }
    state.cases = await Sync.getLocalCases();
    state.policies = await DB.getAllPolicies ? await DB.getAllPolicies() : [];
    if (state.policies.length === 0) {
      try {
        const resp = await fetch('/api/policies');
        if (resp.ok) {
          state.policies = await resp.json();
          await DB.cachePolicies(state.policies);
        }
      } catch (e) { /* offline */ }
    }
  }

  async function refreshData() {
    await loadData();
    renderAll();
  }

  // ---- 网络状态 ----
  function updateNetBadge() {
    const badge = $('#net-badge');
    if (isOnline()) {
      badge.textContent = '在线';
      badge.className = 'net-badge online';
    } else {
      badge.textContent = '离线';
      badge.className = 'net-badge offline';
    }
    updateSyncBadge();
  }

  async function updateSyncBadge() {
    const badge = $('#sync-badge');
    const queue = await DB.getQueue();
    const pending = queue.filter((q) => q.status === 'pending').length;
    if (pending > 0) {
      badge.textContent = `待同步 ${pending}`;
      badge.className = 'sync-badge pending';
    } else {
      badge.textContent = '已同步';
      badge.className = 'sync-badge';
    }
  }

  function toggleOffline() {
    state.manualOffline = !state.manualOffline;
    updateNetBadge();
    if (!state.manualOffline) {
      doSync();
    } else {
      toast('已进入离线模式，操作将保存在本地', '');
    }
    renderAll();
  }

  // ---- 同步 ----
  async function doSync() {
    if (state.syncing) return;
    if (!isOnline()) {
      toast('离线状态，无法同步', 'error');
      return;
    }
    state.syncing = true;
    updateSyncBadge();
    try {
      const result = await Sync.syncOnce();
      await Sync.pullServerData();
      state.cases = await Sync.getLocalCases();
      state.policies = await DB.getAllPolicies ? await DB.getAllPolicies() : [];
      renderAll();
      if (result.conflicts > 0) {
        toast(`同步完成：${result.synced} 条成功，${result.conflicts} 条冲突已按时间留两版`, '');
      } else if (result.synced > 0) {
        toast(`同步完成：${result.synced} 条已同步`, 'success');
      }
    } catch (e) {
      toast('同步失败：' + e.message, 'error');
    } finally {
      state.syncing = false;
      updateSyncBadge();
    }
  }

  // ---- 渲染 ----
  function renderAll() {
    renderCases();
    renderPolicies();
    renderSync();
    if (state.currentCaseLocalId) {
      const c = state.cases.find((x) => x.local_id === state.currentCaseLocalId);
      if (c) renderCaseDetail(c);
    }
  }

  function renderCases() {
    const list = $('#case-list');
    if (state.cases.length === 0) {
      list.innerHTML = '<div class="empty">暂无案件</div>';
      return;
    }
    list.innerHTML = state.cases.map((c) => {
      const a = c.assessments && c.assessments[0];
      const assessmentStatus = a
        ? (a.recalculated ? 'recalculating' : a.valid ? 'valid' : 'invalid')
        : 'none';
      const syncTag = c.dirty
        ? '<span class="sync-tag pending">待同步</span>'
        : c.conflict_versions
        ? '<span class="sync-tag conflict">两版冲突</span>'
        : '<span class="sync-tag synced">已同步</span>';
      return `
        <div class="case-card" data-id="${esc(c.local_id)}">
          <div class="case-card-head">
            <div>
              <div class="case-no">${esc(c.case_number)}</div>
              <div class="case-plate">${esc(c.policy ? c.policy.vehicle_plate : '-')}</div>
            </div>
            <span class="status-badge status-${c.status}">${statusLabel(c.status)}</span>
          </div>
          <div class="case-card-meta">
            <div>领取人：<span class="assignee">${esc(c.assignee ? c.assignee.name : '未领取')}</span></div>
            <div>定损：${assessmentLabel(assessmentStatus)}</div>
          </div>
          <div class="case-card-foot">
            <span class="hint">${fmtTime(c.updated_at)}</span>
            ${syncTag}
          </div>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.case-card').forEach((el) => {
      el.addEventListener('click', () => openCase(el.dataset.id));
    });
  }

  function statusLabel(s) {
    return ({
      pending: '待领取', claimed: '已领取', surveying: '查勘中',
      assessing: '定损中', completed: '已完成',
    })[s] || s;
  }

  function assessmentLabel(s) {
    return ({
      none: '未登记', valid: '有效', invalid: '已作废', recalculating: '待确认重算',
    })[s] || s;
  }

  function renderPolicies() {
    const list = $('#policy-list');
    if (state.policies.length === 0) {
      list.innerHTML = '<div class="empty">暂无保单</div>';
      return;
    }
    list.innerHTML = state.policies.map((p) => `
      <div class="policy-card" data-id="${esc(p.id)}">
        <div class="policy-head">
          <span class="policy-no">${esc(p.policy_number)}</span>
          <span class="policy-ver">v${p.version}</span>
        </div>
        <div class="policy-coverage">
          ${Object.entries(p.coverage).map(([k, v]) =>
            `<span class="coverage-chip">${esc(k)}：${typeof v === 'number' ? fmtMoney(v) : (v ? '是' : '否')}</span>`
          ).join('')}
        </div>
        <div class="policy-actions">
          <button class="btn btn-ghost btn-sm" data-action="edit-policy">更新保单</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.policy-card').forEach((el) => {
      el.querySelector('[data-action="edit-policy"]').addEventListener('click', (e) => {
        e.stopPropagation();
        editPolicy(el.dataset.id);
      });
    });
  }

  async function renderSync() {
    const queue = await DB.getQueue();
    const pending = queue.filter((q) => q.status === 'pending').length;
    const log = await Sync.getSyncLog();
    const badge = isOnline()
      ? '<span class="net-badge online">在线</span>'
      : '<span class="net-badge offline">离线</span>';
    $('#sync-status').innerHTML = `
      <div class="sync-status-row"><span class="label">网络状态</span><span>${badge}</span></div>
      <div class="sync-status-row"><span class="label">待同步变更</span><span>${pending} 条</span></div>
      <div class="sync-status-row"><span class="label">手动离线模式</span><span>${state.manualOffline ? '是' : '否'}</span></div>
      <div class="sync-status-row">
        <span class="label">模拟离线</span>
        <button class="btn btn-ghost btn-sm" id="toggle-offline">${state.manualOffline ? '恢复网络' : '模拟离线'}</button>
      </div>
    `;
    $('#toggle-offline').addEventListener('click', toggleOffline);

    $('#sync-log').innerHTML = log.length === 0
      ? '<div class="empty">暂无同步记录</div>'
      : log.map((l) => `
        <div class="sync-log-item ${l.type}">
          <div>${esc(l.message)}</div>
          <div class="sync-log-time">${fmtTime(l.time)}</div>
        </div>
      `).join('');
  }

  // ---- 案件详情 ----
  function openCase(localId) {
    state.currentCaseLocalId = localId;
    const c = state.cases.find((x) => x.local_id === localId);
    if (!c) return;
    $('#case-drawer').classList.remove('hidden');
    renderCaseDetail(c);
  }

  function closeCase() {
    $('#case-drawer').classList.add('hidden');
    state.currentCaseLocalId = null;
  }

  function renderCaseDetail(c) {
    const a = c.assessments && c.assessments[0];
    const isAssignee = c.assignee && c.assignee.id === state.user.id;
    const canClaim = c.status === 'pending';
    const canEdit = isAssignee && ['claimed', 'surveying', 'assessing'].includes(c.status);

    $('#drawer-title').textContent = c.case_number;
    $('#drawer-case-no').textContent = `${c.policy ? c.policy.vehicle_plate : ''} · ${statusLabel(c.status)}`;

    let html = '';

    // 领取信息
    html += `<div class="detail-section">
      <div class="detail-section-title">案件信息</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="label">案号</span><span class="value">${esc(c.case_number)}</span></div>
        <div class="detail-item"><span class="label">状态</span><span class="value">${statusLabel(c.status)}</span></div>
        <div class="detail-item"><span class="label">车牌号</span><span class="value">${esc(c.policy ? c.policy.vehicle_plate : '-')}</span></div>
        <div class="detail-item"><span class="label">保单号</span><span class="value">${esc(c.policy ? c.policy.policy_number : '-')}</span></div>
      </div>`;
    if (c.assignee) {
      html += `<div class="claimed-by" style="margin-top:12px">
        <div class="avatar">${esc(c.assignee.name[0])}</div>
        <div>已被 <strong>${esc(c.assignee.name)}</strong> 领取 · ${fmtTime(c.claimed_at)}</div>
      </div>`;
    }
    html += `</div>`;

    // 领取按钮
    if (canClaim) {
      html += `<div class="detail-section">
        <div class="detail-section-title">领取案件</div>
        <p class="hint" style="margin-bottom:10px">领取后案件将锁定给您，其他人无法再领取。</p>
        <button class="btn btn-primary" id="claim-btn" ${isOnline() ? '' : 'disabled'}>
          ${isOnline() ? '领取案件' : '离线无法领取'}
        </button>
        ${!isOnline() ? '<div class="flow-hint">领取需要在线状态，请恢复网络后操作。</div>' : ''}
      </div>`;
    }

    // 车损登记
    if (canEdit) {
      html += `<div class="detail-section">
        <div class="detail-section-title">车损部位与估损金额</div>
        <div class="parts-list" id="parts-list">
          ${(a ? a.damage_parts : []).map((p, i) => partRowHtml(p, i)).join('')}
        </div>
        <button class="add-part-btn" id="add-part">+ 添加车损部位</button>
        <div class="estimated-total">
          <span>估损总金额</span>
          <span class="amount" id="estimated-total">${fmtMoney(a ? a.estimated_total : 0)}</span>
        </div>
        <button class="btn btn-primary" id="save-damage" style="margin-top:12px;width:100%">
          ${c.dirty ? '保存并同步' : '保存车损登记'}
        </button>
        ${!isOnline() ? '<div class="flow-hint">离线状态：保存后将在本地登记，恢复网络自动同步。</div>' : ''}
      </div>`;
    } else if (a) {
      html += `<div class="detail-section">
        <div class="detail-section-title">车损部位与估损金额</div>
        <div class="parts-list">
          ${a.damage_parts.map((p) => partRowHtml(p, null)).join('')}
        </div>
        <div class="estimated-total">
          <span>估损总金额</span>
          <span class="amount">${fmtMoney(a.estimated_total)}</span>
        </div>
      </div>`;
    }

    // 定损结论
    if (a) {
      const conc = a.recalculated ? 'recalculating' : a.valid ? 'valid' : 'invalid';
      const concTitle = {
        valid: '✅ 定损结论有效',
        invalid: '⚠️ 定损结论已作废',
        recalculating: '🔄 定损结论待确认重算',
      }[conc];
      html += `<div class="detail-section">
        <div class="detail-section-title">定损结论</div>
        <div class="conclusion-box ${conc}">
          <div class="conclusion-title">${concTitle}</div>
          ${a.invalid_reason ? `<div class="conclusion-detail">${esc(a.invalid_reason)}</div>` : ''}
          ${a.valid ? `<div class="conclusion-detail">
            核定损失金额：<span class="amount">${fmtMoney(a.assessed_amount)}</span> · ${esc(a.conclusion)}
          </div>` : ''}
        </div>`;
      if (a.recalculated) {
        html += `<div class="recalc-box">
          <div class="recalc-title">保单更新，已自动重算</div>
          <div class="conclusion-detail">原定损结论作废，根据新保单条款重算：</div>
          <div class="recalc-amount">${fmtMoney(a.recalculated.assessed_amount)}</div>
          <div class="conclusion-detail">${esc(a.recalculated.conclusion)} · 保单 v${a.recalculated.policy_version}</div>
          <button class="btn btn-success btn-sm" id="confirm-recalc" style="margin-top:10px" ${isOnline() ? '' : 'disabled'}>
            确认重算结果
          </button>
        </div>`;
      }
      html += `</div>`;
    }

    // 流转操作
    if (isAssignee && ['surveying', 'assessing'].includes(c.status)) {
      const flowLabel = {
        surveying: '流转至定损',
        assessing: '完成案件',
      }[c.status];
      const flowDisabled = a && !a.valid;
      html += `<div class="detail-section">
        <div class="detail-section-title">案件流转</div>
        <div class="flow-actions">
          <button class="btn btn-primary" id="flow-btn" ${flowDisabled || !isOnline() ? 'disabled' : ''}>
            ${flowLabel}
          </button>
        </div>
        ${flowDisabled ? '<div class="flow-hint">定损结论已作废或待确认，不能流转。请先确认重算结果。</div>' : ''}
        ${!isOnline() ? '<div class="flow-hint">流转需要在线状态。</div>' : ''}
      </div>`;
    }

    // 版本历史（两版冲突）
    if (c.conflict_versions || (a && a.conflict_versions)) {
      const versions = (a && a.conflict_versions) || c.conflict_versions;
      html += `<div class="detail-section">
        <div class="detail-section-title">版本历史（两版）</div>
        <div class="versions-list">
          ${versions.map((v, i) => {
            const isCurrent = i === versions.length - 1;
            return `<div class="version-card ${isCurrent ? 'current' : ''} conflict-${v.source}">
              <span class="version-tag ${isCurrent ? 'current' : v.source}">${isCurrent ? '当前' : v.source === 'local' ? '本地' : '公司台账'}</span>
              <div class="version-time">${fmtTime(v.updated_at)} · ${v.source === 'local' ? '离线登记' : '公司台账'}</div>
              <div class="version-data">
                ${v.data.damage_parts ? v.data.damage_parts.map((p) =>
                  `<div class="row"><span>${esc(p.part)}</span><span>${fmtMoney(p.amount)}</span></div>`
                ).join('') : ''}
                <div class="row"><span>估损总额</span><strong>${fmtMoney(v.data.estimated_total)}</strong></div>
                ${v.data.assessed_amount ? `<div class="row"><span>核定金额</span><strong>${fmtMoney(v.data.assessed_amount)}</strong></div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
        <p class="hint" style="margin-top:8px">两边都修改过，已按时间保留两版，当前显示最新时间版本。</p>
      </div>`;
    }

    $('#drawer-body').innerHTML = html;
    bindCaseDetailEvents(c);
  }

  function partRowHtml(p, i) {
    return `<div class="part-row" data-index="${i}">
      <input type="text" class="part-name" placeholder="部位名称" value="${esc(p.part)}" ${i === null ? 'disabled' : ''} />
      <input type="number" class="part-amount" placeholder="金额" value="${p.amount}" ${i === null ? 'disabled' : ''} />
      ${i !== null ? '<button class="remove-part" title="删除">✕</button>' : ''}
    </div>`;
  }

  function bindCaseDetailEvents(c) {
    const claimBtn = $('#claim-btn');
    if (claimBtn) claimBtn.addEventListener('click', () => claimCase(c));

    const addPart = $('#add-part');
    if (addPart) addPart.addEventListener('click', () => {
      const list = $('#parts-list');
      const idx = list.children.length;
      const div = document.createElement('div');
      div.className = 'part-row';
      div.dataset.index = idx;
      div.innerHTML = `
        <input type="text" class="part-name" placeholder="部位名称" />
        <input type="number" class="part-amount" placeholder="金额" />
        <button class="remove-part" title="删除">✕</button>
      `;
      list.appendChild(div);
      bindPartRow(div);
      updateEstimatedTotal();
    });

    $$('#parts-list .part-row').forEach((row) => bindPartRow(row));

    const saveBtn = $('#save-damage');
    if (saveBtn) saveBtn.addEventListener('click', () => saveDamage(c));

    const confirmBtn = $('#confirm-recalc');
    if (confirmBtn) confirmBtn.addEventListener('click', () => confirmRecalculation(c));

    const flowBtn = $('#flow-btn');
    if (flowBtn) flowBtn.addEventListener('click', () => flowCase(c));
  }

  function bindPartRow(row) {
    const nameInput = row.querySelector('.part-name');
    const amountInput = row.querySelector('.part-amount');
    const removeBtn = row.querySelector('.remove-part');
    [nameInput, amountInput].forEach((inp) => {
      inp.addEventListener('input', updateEstimatedTotal);
    });
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        row.remove();
        updateEstimatedTotal();
      });
    }
  }

  function updateEstimatedTotal() {
    const rows = $$('#parts-list .part-row');
    let total = 0;
    rows.forEach((row) => {
      const amt = parseFloat(row.querySelector('.part-amount').value) || 0;
      total += amt;
    });
    const el = $('#estimated-total');
    if (el) el.textContent = fmtMoney(total);
  }

  function collectParts() {
    const rows = $$('#parts-list .part-row');
    const parts = [];
    rows.forEach((row) => {
      const name = row.querySelector('.part-name').value.trim();
      const amt = parseFloat(row.querySelector('.part-amount').value) || 0;
      if (name) parts.push({ part: name, amount: amt });
    });
    return parts;
  }

  // ---- 领取 ----
  async function claimCase(c) {
    if (!isOnline()) {
      toast('离线状态无法领取', 'error');
      return;
    }
    try {
      const resp = await fetch(`/api/cases/${c.server_id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: state.user.id }),
      });
      const result = await resp.json();
      if (resp.ok) {
        toast('领取成功', 'success');
        await refreshData();
        openCase(c.local_id);
      } else if (result.error === 'already_claimed') {
        toast(`该案件已被 ${result.claimed_by} 领取`, 'error');
        await refreshData();
        openCase(c.local_id);
      } else {
        toast(result.message || '领取失败', 'error');
      }
    } catch (e) {
      toast('领取失败：' + e.message, 'error');
    }
  }

  // ---- 保存车损 ----
  async function saveDamage(c) {
    const parts = collectParts();
    if (parts.length === 0) {
      toast('请至少添加一个车损部位', 'error');
      return;
    }
    const total = parts.reduce((s, p) => s + p.amount, 0);

    // 找到本地定损记录
    let localAssessment = (c.assessments && c.assessments[0]) || null;
    const now = new Date().toISOString();

    if (localAssessment) {
      // 更新
      localAssessment.data.damage_parts = parts;
      localAssessment.data.estimated_total = total;
      localAssessment.dirty = true;
      localAssessment.local_updated_at = now;
      await DB.upsertAssessment(localAssessment);
      // 加入同步队列（local_id 与本地记录一致，便于回写）
      await DB.addToQueue({
        local_id: localAssessment.local_id,
        type: 'assessment',
        server_id: localAssessment.server_id,
        case_local_id: c.local_id,
        case_server_id: c.server_id,
        base_version: localAssessment.version,
        data: {
          damage_parts: parts,
          estimated_total: total,
        },
        local_updated_at: now,
      });
    } else {
      // 新建本地定损记录
      const newLocal = {
        local_id: DB.uid(),
        server_id: null,
        case_local_id: c.local_id,
        case_server_id: c.server_id,
        data: {
          id: null,
          case_id: c.server_id,
          damage_parts: parts,
          estimated_total: total,
          assessed_amount: 0,
          conclusion: '属于保险责任',
          policy_version: c.policy ? c.policy.version : 1,
          valid: true,
          invalid_reason: null,
          recalculated: null,
          version: 0,
          history: [],
        },
        version: 0,
        dirty: true,
        conflict_versions: null,
        local_updated_at: now,
      };
      await DB.upsertAssessment(newLocal);
      // 加入同步队列（新建，server_id 为 null）
      await DB.addToQueue({
        local_id: newLocal.local_id,
        type: 'assessment',
        server_id: null,
        case_local_id: c.local_id,
        case_server_id: c.server_id,
        base_version: null,
        data: {
          case_id: c.server_id,
          damage_parts: parts,
          estimated_total: total,
        },
        local_updated_at: now,
      });
    }

    // 更新本地案件：标记 dirty，乐观更新状态为查勘中
    const localCase = await DB.getCaseByServerId(c.server_id);
    if (localCase) {
      localCase.dirty = true;
      localCase.local_updated_at = now;
      if (localCase.data.status === 'claimed') {
        localCase.data.status = 'surveying';
      }
      await DB.upsertCase(localCase);
    }

    toast('车损登记已保存', 'success');
    updateSyncBadge();
    renderCaseDetail(c);

    if (isOnline()) {
      doSync().then(() => {
        const updated = state.cases.find((x) => x.local_id === c.local_id);
        if (updated) openCase(updated.local_id);
      });
    }
  }

  // ---- 确认重算 ----
  async function confirmRecalculation(c) {
    const a = c.assessments && c.assessments[0];
    if (!a || !a.server_id) {
      toast('请先同步定损记录', 'error');
      return;
    }
    if (!isOnline()) {
      toast('离线状态无法确认', 'error');
      return;
    }
    try {
      const resp = await fetch(`/api/assessments/${a.server_id}/confirm-recalculation`, {
        method: 'POST',
      });
      const result = await resp.json();
      if (resp.ok) {
        toast('重算结果已确认', 'success');
        await refreshData();
        openCase(c.local_id);
      } else {
        toast(result.message || '操作失败', 'error');
      }
    } catch (e) {
      toast('操作失败：' + e.message, 'error');
    }
  }

  // ---- 流转 ----
  async function flowCase(c) {
    if (!isOnline()) {
      toast('离线状态无法流转', 'error');
      return;
    }
    try {
      const resp = await fetch(`/api/cases/${c.server_id}/flow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: state.user.id }),
      });
      const result = await resp.json();
      if (resp.ok) {
        toast('已流转至下一环节', 'success');
        await refreshData();
        openCase(c.local_id);
      } else if (result.error === 'assessment_invalid') {
        toast(result.message, 'error');
      } else {
        toast(result.message || '流转失败', 'error');
      }
    } catch (e) {
      toast('流转失败：' + e.message, 'error');
    }
  }

  // ---- 保单更新 ----
  function editPolicy(policyId) {
    const p = state.policies.find((x) => x.id === policyId);
    if (!p) return;
    state.currentCaseLocalId = null;
    const newCoverage = { ...p.coverage };
    const html = `
      <div class="detail-section">
        <div class="detail-section-title">更新保单 ${esc(p.policy_number)}</div>
        <p class="hint" style="margin-bottom:12px">更新保额或条款后，该保单项下所有定损结论将自动作废并重算。</p>
        ${Object.entries(newCoverage).map(([k, v]) => `
          <div class="part-row" style="margin-bottom:8px">
            <input type="text" value="${esc(k)}" disabled style="flex:0 0 100px" />
            <input type="number" class="coverage-input" data-key="${esc(k)}" value="${typeof v === 'number' ? v : (v ? 1 : 0)}" />
          </div>
        `).join('')}
        <div class="flow-actions" style="margin-top:12px">
          <button class="btn btn-primary" id="save-policy" ${isOnline() ? '' : 'disabled'}>保存并重算</button>
          <button class="btn btn-ghost" id="cancel-policy">取消</button>
        </div>
        ${!isOnline() ? '<div class="flow-hint">更新保单需要在线状态。</div>' : ''}
      </div>
    `;
    const body = $('#drawer-body');
    body.innerHTML = html;
    $('#case-drawer').classList.remove('hidden');
    $('#drawer-title').textContent = '更新保单';
    $('#drawer-case-no').textContent = p.policy_number;

    $('#cancel-policy').addEventListener('click', () => {
      closeCase();
      renderAll();
    });
    $('#save-policy').addEventListener('click', async () => {
      const patch = { coverage: {} };
      body.querySelectorAll('.coverage-input').forEach((inp) => {
        const key = inp.dataset.key;
        const val = parseFloat(inp.value) || 0;
        if (key === '不计免赔') {
          patch.coverage[key] = val > 0;
        } else {
          patch.coverage[key] = val;
        }
      });
      try {
        const resp = await fetch(`/api/policies/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const result = await resp.json();
        if (resp.ok) {
          toast(`保单已更新，${result.affected.length} 条定损结论已作废并重算`, 'success');
          await refreshData();
          closeCase();
        } else {
          toast(result.message || '更新失败', 'error');
        }
      } catch (e) {
        toast('更新失败：' + e.message, 'error');
      }
    });
  }

  // ---- Tab 切换 ----
  function switchTab(tab) {
    state.currentTab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'sync') renderSync();
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    $('#logout-btn').addEventListener('click', logout);
    $$('.tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    $('#refresh-cases').addEventListener('click', refreshData);
    $('#sync-now').addEventListener('click', doSync);
    $('#drawer-close').addEventListener('click', closeCase);
    $('#drawer-mask').addEventListener('click', closeCase);
  }

  // 启动
  bindEvents();
  init();
})();
