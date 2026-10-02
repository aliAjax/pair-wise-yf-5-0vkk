// server/index.js
const express = require('express');
const path = require('path');
const store = require('./store');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

store.load();

// ---- 用户 ----
app.get('/api/users', (req, res) => {
  res.json(store.clone(store.data.users));
});

// ---- 案件 ----
app.get('/api/cases', (req, res) => {
  const cases = store.clone(store.data.cases);
  const assessments = store.clone(store.data.assessments);
  const users = store.clone(store.data.users);
  const policies = store.clone(store.data.policies);
  const result = cases.map((c) => ({
    ...c,
    assignee: users.find((u) => u.id === c.assigned_to) || null,
    policy: policies.find((p) => p.id === c.policy_id) || null,
    assessment: assessments.find((a) => a.case_id === c.id) || null,
  }));
  res.json(result);
});

app.get('/api/cases/:id', (req, res) => {
  const c = store.data.cases.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found', message: '案件不存在' });
  const assessments = store.data.assessments.filter((a) => a.case_id === c.id);
  const users = store.data.users;
  const policies = store.data.policies;
  res.json({
    ...store.clone(c),
    assignee: users.find((u) => u.id === c.assigned_to) || null,
    policy: policies.find((p) => p.id === c.policy_id) || null,
    assessments: store.clone(assessments),
  });
});

app.post('/api/cases/:id/claim', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'bad_request', message: '缺少 user_id' });
  const result = store.claimCase(req.params.id, user_id);
  if (result.error === 'not_found') return res.status(404).json(result);
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

app.post('/api/cases/:id/flow', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'bad_request', message: '缺少 user_id' });
  const result = store.flowCase(req.params.id, user_id);
  if (result.error === 'not_found') return res.status(404).json(result);
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

// ---- 定损 ----
app.post('/api/assessments', (req, res) => {
  const { case_id, damage_parts, estimated_total, user_id } = req.body;
  if (!case_id) return res.status(400).json({ error: 'bad_request', message: '缺少 case_id' });
  const c = store.data.cases.find((x) => x.id === case_id);
  if (!c) return res.status(404).json({ error: 'not_found', message: '案件不存在' });
  const policy = store.data.policies.find((p) => p.id === c.policy_id);
  const id = 'a-' + Math.random().toString(36).slice(2, 8);
  const a = {
    id,
    case_id,
    damage_parts: damage_parts || [],
    estimated_total: estimated_total || 0,
    assessed_amount: 0,
    conclusion: '属于保险责任',
    policy_version: policy ? policy.version : 1,
    valid: true,
    invalid_reason: null,
    recalculated: null,
    version: 1,
    history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (policy) {
    const r = store.recalculate(a, policy);
    a.assessed_amount = r.assessed_amount;
    a.conclusion = r.conclusion;
  }
  a.history.push({
    version: 1,
    data: {
      damage_parts: store.clone(a.damage_parts),
      estimated_total: a.estimated_total,
      assessed_amount: a.assessed_amount,
      conclusion: a.conclusion,
    },
    updated_at: a.updated_at,
    source: 'server',
  });
  store.data.assessments.push(a);
  if (c.status === 'claimed') c.status = 'surveying';
  c.updated_at = new Date().toISOString();
  c.version += 1;
  store.save();
  res.json({ ok: true, assessment: store.clone(a), case: store.clone(c) });
});

app.post('/api/assessments/:id/confirm-recalculation', (req, res) => {
  const result = store.confirmRecalculation(req.params.id);
  if (result.error === 'not_found') return res.status(404).json(result);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ---- 保单 ----
app.get('/api/policies', (req, res) => {
  res.json(store.clone(store.data.policies));
});

app.patch('/api/policies/:id', (req, res) => {
  const result = store.updatePolicy(req.params.id, req.body);
  if (result.error === 'not_found') return res.status(404).json(result);
  res.json(result);
});

// ---- 同步 ----
app.post('/api/sync', (req, res) => {
  const { changes } = req.body;
  if (!Array.isArray(changes))
    return res.status(400).json({ error: 'bad_request', message: 'changes 必须是数组' });
  const results = store.syncChanges(changes);
  res.json({ results });
});

// ---- 重置（演示用） ----
app.post('/api/reset', (req, res) => {
  store.reset();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`理赔查勘台服务运行在 http://localhost:${PORT}`);
});
