// public/db.js
// IndexedDB 本地存储：离线数据、变更队列、冲突版本、元信息
(function (global) {
  const DB_NAME = 'claims-survey-db';
  const DB_VERSION = 1;

  const STORES = {
    meta: 'meta',
    users: 'users',
    policies: 'policies',
    cases: 'cases',
    assessments: 'assessments',
    queue: 'sync_queue',
  };

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORES.meta)) {
          db.createObjectStore(STORES.meta);
        }
        if (!db.objectStoreNames.contains(STORES.users)) {
          db.createObjectStore(STORES.users, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.policies)) {
          db.createObjectStore(STORES.policies, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.cases)) {
          const s = db.createObjectStore(STORES.cases, { keyPath: 'local_id' });
          s.createIndex('server_id', 'server_id', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.assessments)) {
          const s = db.createObjectStore(STORES.assessments, { keyPath: 'local_id' });
          s.createIndex('server_id', 'server_id', { unique: false });
          s.createIndex('case_local_id', 'case_local_id', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.queue)) {
          db.createObjectStore(STORES.queue, { keyPath: 'local_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function uid() {
    return 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---- 通用 CRUD ----
  async function getAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function del(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clear(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- meta ----
  async function getMeta(key) {
    return get(STORES.meta, key);
  }
  async function setMeta(key, value) {
    return put(STORES.meta, value);
  }

  // ---- users / policies 缓存 ----
  async function getAllUsers() {
    return getAll(STORES.users);
  }

  async function getAllPolicies() {
    return getAll(STORES.policies);
  }

  async function cacheUsers(users) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.users, 'readwrite');
      const store = tx.objectStore(STORES.users);
      store.clear();
      users.forEach((u) => store.put(u));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function cachePolicies(policies) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.policies, 'readwrite');
      const store = tx.objectStore(STORES.policies);
      store.clear();
      policies.forEach((p) => store.put(p));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- cases ----
  // 本地 case 结构: { local_id, server_id, data, version, dirty, local_updated_at }
  async function getAllCases() {
    return getAll(STORES.cases);
  }

  async function getCaseByServerId(serverId) {
    const all = await getAll(STORES.cases);
    return all.find((c) => c.server_id === serverId);
  }

  async function upsertCase(localCase) {
    return put(STORES.cases, localCase);
  }

  // ---- assessments ----
  // 本地 assessment 结构: { local_id, server_id, case_local_id, case_server_id, data, version, dirty, local_updated_at, conflict_versions }
  async function getAllAssessments() {
    return getAll(STORES.assessments);
  }

  async function getAssessmentByServerId(serverId) {
    const all = await getAll(STORES.assessments);
    return all.find((a) => a.server_id === serverId);
  }

  async function getAssessmentsByCaseLocalId(caseLocalId) {
    const all = await getAll(STORES.assessments);
    return all.filter((a) => a.case_local_id === caseLocalId);
  }

  async function upsertAssessment(localAssessment) {
    return put(STORES.assessments, localAssessment);
  }

  // ---- sync queue ----
  // 队列项: { local_id, type, server_id, case_local_id, base_version, data, local_updated_at, status }
  async function getQueue() {
    return getAll(STORES.queue);
  }

  async function addToQueue(item) {
    if (!item.local_id) item.local_id = uid();
    if (!item.local_updated_at) item.local_updated_at = new Date().toISOString();
    item.status = 'pending';
    return put(STORES.queue, item);
  }

  async function updateQueueItem(item) {
    return put(STORES.queue, item);
  }

  async function removeFromQueue(localId) {
    return del(STORES.queue, localId);
  }

  async function clearQueue() {
    return clear(STORES.queue);
  }

  // ---- 全量重置 ----
  async function clearAll() {
    await Promise.all([
      clear(STORES.meta),
      clear(STORES.users),
      clear(STORES.policies),
      clear(STORES.cases),
      clear(STORES.assessments),
      clear(STORES.queue),
    ]);
  }

  global.DB = {
    uid,
    openDB,
    get,
    getMeta,
    setMeta,
    getAllUsers,
    getAllPolicies,
    cacheUsers,
    cachePolicies,
    getAllCases,
    getCaseByServerId,
    upsertCase,
    getAllAssessments,
    getAssessmentByServerId,
    getAssessmentsByCaseLocalId,
    upsertAssessment,
    getQueue,
    addToQueue,
    updateQueueItem,
    removeFromQueue,
    clearQueue,
    clearAll,
    STORES,
  };
})(window);
