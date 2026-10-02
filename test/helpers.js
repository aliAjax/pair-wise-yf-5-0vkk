const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 每个测试文件使用独立的临时数据库文件，启动一个临时端口的服务实例。
 */
function setupHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-test-'));
  const dbPath = path.join(dir, 'db.json');
  process.env.DB_PATH = dbPath;
  process.env.PORT = '0';
  // 清缓存，确保 server.js 按新的 DB_PATH 初始化
  delete require.cache[require.resolve('../server.js')];
  const { server } = require('../server.js');

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;

      const call = async (p, body, method = 'POST') => {
        const res = await fetch(`${base}${p}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, json };
      };

      const reset = async () => call('/api/reset', {});
      const state = async () => (await call('/api/state', undefined, 'GET')).json;
      const stop = () => new Promise((r) => server.close(r));

      resolve({ base, call, reset, state, stop, dbPath });
    });
  });
}

module.exports = { setupHarness };
