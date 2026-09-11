import { EventEmitter } from 'node:events';
import { apply, name, inject } from 'file:///D:/DSH_all/Emily_Daily/dsh-version-panel/lib/index.js';

// 模拟真实 DSH host 进程的启动入口（否则读不到运行中的版本）
process.argv[1] = 'D:\\deepseek-harness\\apps\\cli\\src\\bin.ts';

console.log('plugin name:', name);
console.log('plugin inject:', JSON.stringify(inject));

let handler = null;
const ctx = {
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      console.log('route registered:', route.kind, route.path);
      handler = route.handler;
      return () => {};
    },
  },
};

apply(ctx);
if (handler === null) {
  console.log('NO HANDLER REGISTERED');
  process.exit(1);
}

function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}

function fakeRes() {
  const out = { status: null, body: null };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(body) { out.body = body; },
  };
}

async function call(method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  return { status: res.out.status, data: JSON.parse(res.out.body) };
}

const state = await call('GET', '/dsh-version/api');
console.log('\n=== GET /dsh-version/api ===');
console.log('HTTP', state.status);
console.log(JSON.stringify({
  current: state.data.current,
  currentName: state.data.currentName,
  currentDir: state.data.currentDir,
  latest: state.data.latest,
  latestTag: state.data.latestTag,
  updateAvailable: state.data.updateAvailable,
  installType: state.data.installType,
  repoRoot: state.data.repoRoot,
  upstreamSource: state.data.upstreamSource,
  upstreamError: state.data.upstreamError,
  updateCommand: state.data.updateCommand,
}, null, 2));

const check = await call('POST', '/dsh-version/api', { action: 'check' });
console.log('\n=== POST check ===');
console.log('HTTP', check.status, '| latest =', check.data.latest, '| err =', check.data.upstreamError);

const bad = await call('POST', '/dsh-version/api', { action: 'nope' });
console.log('\n=== POST unknown action ===');
console.log('HTTP', bad.status, '|', JSON.stringify(bad.data));

const upd = await call('POST', '/dsh-version/api', { action: 'update' });
console.log('\n=== POST update WITHOUT confirm (must be rejected) ===');
console.log('HTTP', upd.status, '|', JSON.stringify(upd.data));
