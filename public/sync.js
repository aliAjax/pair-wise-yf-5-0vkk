// public/sync.js
// 同步管理器：把本地离线变更推送到服务端，处理冲突（两版），回写本地
(function (global) {
  const SYNC_LOG_KEY = 'sync_log';

  async function getSyncLog() {
    return (await DB.getMeta(SYNC_LOG_KEY)) || [];
  }

  async function appendSyncLog(entry) {
    const log = await getSyncLog();
    log.unshift(entry);
    if (log.length > 50) log.length = 50;
    await DB.setMeta(SYNC_LOG_KEY, log);
  }

  async function clearSyncLog() {
    await DB.setMeta(SYNC_LOG_KEY, []);
  }

  // 构建同步请求：把队列里的 pending 项转成 changes
  async function buildChanges() {
    const queue = await DB.getQueue();
    const pending = queue.filter((q) => q.status === 'pending');
    return pending.map((q) => ({
      local_id: q.local_id,
      server_id: q.server_id,
      type: q.type,
      base_version: q.base_version,
      data: q.data,
      local_updated_at: q.local_updated_at,
    }));
  }

  // 执行一次同步
  async function syncOnce() {
    const changes = await buildChanges();
    if (changes.length === 0) {
      return { synced: 0, conflicts: 0, results: [] };
    }
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    if (!resp.ok) throw new Error('同步请求失败: ' + resp.status);
    const { results } = await resp.json();

    let synced = 0;
    let conflicts = 0;

    for (const r of results) {
      const queue = await DB.getQueue();
      const item = queue.find((q) => q.local_id === r.local_id);
      if (!item) continue;

      if (r.status === 'synced') {
        // 回写本地记录（先按 local_id 查找，再按 server_id）
        if (item.type === 'assessment') {
          let local = await DB.get(DB.STORES.assessments, item.local_id);
          if (!local && item.server_id) {
            local = await DB.getAssessmentByServerId(item.server_id);
          }
          if (local) {
            local.server_id = r.server_id;
            local.version = r.version;
            local.data = r.assessment;
            local.dirty = false;
            local.conflict_versions = null;
            await DB.upsertAssessment(local);
          }
        } else if (item.type === 'case') {
          let local = await DB.get(DB.STORES.cases, item.local_id);
          if (!local && item.server_id) {
            local = await DB.getCaseByServerId(item.server_id);
          }
          if (local) {
            local.version = r.version;
            local.data = r.case;
            local.dirty = false;
            await DB.upsertCase(local);
          }
        }
        item.status = 'synced';
        await DB.updateQueueItem(item);
        synced++;
        await appendSyncLog({
          type: 'synced',
          message: `${item.type === 'assessment' ? '定损记录' : '案件'} ${r.server_id} 同步成功`,
          time: new Date().toISOString(),
        });
      } else if (r.status === 'conflict') {
        // 冲突：两版都保留
        if (item.type === 'assessment') {
          let local = await DB.get(DB.STORES.assessments, item.local_id);
          if (!local && item.server_id) {
            local = await DB.getAssessmentByServerId(item.server_id);
          }
          if (local) {
            local.server_id = r.server_id;
            local.version = r.version;
            local.data = r.assessment;
            local.dirty = false;
            local.conflict_versions = r.versions;
            await DB.upsertAssessment(local);
          }
        } else if (item.type === 'case') {
          let local = await DB.get(DB.STORES.cases, item.local_id);
          if (!local && item.server_id) {
            local = await DB.getCaseByServerId(item.server_id);
          }
          if (local) {
            local.version = r.version;
            local.data = r.case;
            local.dirty = false;
            local.conflict_versions = r.versions;
            await DB.upsertCase(local);
          }
        }
        item.status = 'conflict';
        await DB.updateQueueItem(item);
        conflicts++;
        await appendSyncLog({
          type: 'conflict',
          message: `${item.type === 'assessment' ? '定损记录' : '案件'} ${r.server_id} 两版冲突，已按时间保留两版`,
          time: new Date().toISOString(),
        });
      } else {
        item.status = 'error';
        await DB.updateQueueItem(item);
        await appendSyncLog({
          type: 'error',
          message: `同步失败: ${r.message || '未知错误'}`,
          time: new Date().toISOString(),
        });
      }
    }

    return { synced, conflicts, results };
  }

  // 拉取服务端最新数据到本地缓存
  async function pullServerData() {
    const [casesResp, policiesResp, usersResp] = await Promise.all([
      fetch('/api/cases'),
      fetch('/api/policies'),
      fetch('/api/users'),
    ]);
    if (!casesResp.ok || !policiesResp.ok || !usersResp.ok)
      throw new Error('拉取服务端数据失败');
    const cases = await casesResp.json();
    const policies = await policiesResp.json();
    const users = await usersResp.json();

    await DB.cachePolicies(policies);
    await DB.cacheUsers(users);

    // 合并案件：保留本地未同步的修改
    for (const serverCase of cases) {
      const existing = await DB.getCaseByServerId(serverCase.id);
      if (existing && existing.dirty) {
        // 本地有未同步修改，保留本地版本，不覆盖
        continue;
      }
      if (existing) {
        existing.data = serverCase;
        existing.version = serverCase.version;
        existing.dirty = false;
        await DB.upsertCase(existing);
      } else {
        await DB.upsertCase({
          local_id: DB.uid(),
          server_id: serverCase.id,
          data: serverCase,
          version: serverCase.version,
          dirty: false,
          local_updated_at: serverCase.updated_at,
        });
      }
    }

    // 合并定损记录
    for (const serverCase of cases) {
      const assessments = serverCase.assessments || [];
      for (const sa of assessments) {
        const existing = await DB.getAssessmentByServerId(sa.id);
        if (existing && existing.dirty) continue;
        const caseLocal = await DB.getCaseByServerId(serverCase.id);
        if (existing) {
          existing.data = sa;
          existing.version = sa.version;
          existing.dirty = false;
          existing.case_local_id = caseLocal ? caseLocal.local_id : existing.case_local_id;
          await DB.upsertAssessment(existing);
        } else {
          await DB.upsertAssessment({
            local_id: DB.uid(),
            server_id: sa.id,
            case_local_id: caseLocal ? caseLocal.local_id : null,
            case_server_id: serverCase.id,
            data: sa,
            version: sa.version,
            dirty: false,
            conflict_versions: null,
            local_updated_at: sa.updated_at,
          });
        }
      }
    }

    return { cases: cases.length, policies: policies.length, users: users.length };
  }

  // 离线时：从本地缓存读取案件列表
  async function getLocalCases() {
    const cases = await DB.getAllCases();
    const assessments = await DB.getAllAssessments();
    const policies = await DB.getAllPolicies ? await DB.getAllPolicies() : [];
    return cases.map((lc) => {
      const caseAssessments = assessments.filter(
        (a) => a.case_server_id === lc.server_id || a.case_local_id === lc.local_id
      );
      return {
        ...lc.data,
        local_id: lc.local_id,
        server_id: lc.server_id,
        dirty: lc.dirty,
        conflict_versions: lc.conflict_versions,
        assessments: caseAssessments.map((a) => ({
          ...a.data,
          local_id: a.local_id,
          server_id: a.server_id,
          dirty: a.dirty,
          conflict_versions: a.conflict_versions,
        })),
      };
    });
  }

  global.Sync = {
    syncOnce,
    pullServerData,
    getLocalCases,
    getSyncLog,
    clearSyncLog,
    appendSyncLog,
  };
})(window);
