import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 模拟真实 DSH host 进程的启动入口（否则读不到运行中的版本）
process.argv[1] = 'D:\\deepseek-harness\\apps\\cli\\src\\bin.ts';
// 把状态文件写进临时 DSH_HOME，避免污染真实 home。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-version-panel-test-'));

// 上游检查打桩，避免测试依赖真实网络。
globalThis.fetch = async (url) => {
  const body = String(url).includes('/releases')
    ? [{
        tag_name: 'dsh-v0.1.6-alpha.2',
        body: 'notes',
        html_url: 'https://example.com/releases/v0.1.6-alpha.2',
        published_at: '2026-09-18T00:00:00Z',
        prerelease: false,
      }]
    : [];
  return {
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};

const mod = await import('file:///D:/DSH_all/Emily_Daily/dsh-version-panel/lib/index.js');
const { apply, name, inject, __internals } = mod;

console.log('plugin name:', name);
console.log('plugin inject:', JSON.stringify(inject));
assert.equal(name, 'dsh-version-panel');
assert.deepEqual(inject, ['webServer', 'agents']);

let handler = null;
let agents = [];
const ctx = {
  effect: (fn) => fn(),
  logger: { warn: () => {} },
  agents: { list: () => agents },
  webServer: {
    register: (route) => {
      handler = route.handler;
      return () => {};
    },
  },
};

// 测试环境禁用自重启，避免测试进程被真实重启杀死。
apply(ctx, { allowRestart: false, autoRestart: false });
assert.equal(typeof handler, 'function', 'route handler must be registered');

function fakeReq(method, url, body, options = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.socket = options.socket ?? { remoteAddress: '127.0.0.1' };
  req.headers = options.headers ?? { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };
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

async function call(method, url, body, options) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body, options), res);
  return { status: res.out.status, data: JSON.parse(res.out.body) };
}

/* 1. GET：空闲宿主 */
agents = [{ id: 'session-a', status: 'idle' }];
let state = await call('GET', '/dsh-version/api');
console.log('\n=== GET /dsh-version/api (idle) ===');
console.log('HTTP', state.status, '| current =', state.data.current, '| hostBusy =', state.data.hostBusy);
assert.equal(state.status, 200);
assert.equal(state.data.hostBusy, false);
assert.equal(state.data.hostActivityKnown, true);
assert.equal(typeof state.data.restart, 'object');
assert.equal(state.data.restart.allowed, false); // 测试配置 allowRestart: false

/* 2. GET：有会话运行 */
agents = [{ id: 'session-a', status: 'running' }];
state = await call('GET', '/dsh-version/api');
assert.equal(state.data.hostBusy, true);
assert.deepEqual(state.data.hostRunning, ['session-a']);

/* 3. update 缺 confirm → 400 */
let res = await call('POST', '/dsh-version/api', { action: 'update' });
console.log('\n=== POST update WITHOUT confirm (must be rejected) ===');
console.log('HTTP', res.status, '|', JSON.stringify(res.data));
assert.equal(res.status, 400);

/* 4. update 有 confirm 但宿主忙 → 409，且不得启动真实更新 */
res = await call('POST', '/dsh-version/api', { action: 'update', confirm: true });
console.log('\n=== POST update while host busy (must be refused) ===');
console.log('HTTP', res.status, '|', JSON.stringify(res.data));
assert.equal(res.status, 409);
assert.equal(res.data.hostBusy, true);
assert.equal(__internals.updateRun.running, false, 'busy guard must not start the update');

/* 5. restart 非本机来源 → 403 */
res = await call('POST', '/dsh-version/api', { action: 'restart' }, { socket: { remoteAddress: '10.0.0.5' } });
console.log('\n=== POST restart from non-loopback (must be refused) ===');
console.log('HTTP', res.status, '|', JSON.stringify(res.data));
assert.equal(res.status, 403);

/* 6. restart 本机但配置禁用 → 409（不会真的重启） */
res = await call('POST', '/dsh-version/api', { action: 'restart' });
console.log('\n=== POST restart with allowRestart: false (must be refused) ===');
console.log('HTTP', res.status, '|', JSON.stringify(res.data));
assert.equal(res.status, 409);
assert.equal(__internals.restartState.scheduled, false);

/* 7. 纯函数：信任边界与监管/调试检测 */
assert.equal(__internals.trustedLoopbackRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
}), true);
assert.equal(__internals.trustedLoopbackRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
}), false);
assert.equal(__internals.trustedLoopbackRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'x-forwarded-for': '1.2.3.4' },
}), false);
assert.equal(__internals.detectedSupervisor({ INVOCATION_ID: 'x' }, 1), 'systemd');
assert.equal(__internals.detectedSupervisor({}, 1234), null);
assert.equal(__internals.detectedDebugger(['--inspect'], ''), 'inspector');
assert.equal(__internals.detectedDebugger([], ''), null);
assert.deepEqual(__internals.hostActivity({}), { known: false, busy: false, running: [] });
assert.equal(__internals.servingPort({ headers: { host: '127.0.0.1:3080' } }), 3080);
assert.equal(__internals.servingPort({ headers: { host: '127.0.0.1' } }), null);

/* 8. 启动命令重建 + helper 源码可编译 */
const launch = __internals.dshLaunch();
assert.equal(launch.viaShell, false);
assert.ok(launch.args.some((argument) => String(argument).endsWith('bin.ts')), 'launch must replay the node entry');
const helper = __internals.restartHelperSource(
  { file: 'node', args: [], viaShell: false, detached: true },
  { cwd: 'C:\\tmp' },
  { out: 'o.log', err: 'e.log' },
  3080,
);
// 只编译不执行（body 末尾的 main() 需要显式调用才会跑）。
new Function('require', helper);
assert.ok(helper.includes('const port = 3080'));

/* 9. P2：宿主身份（运行 vs 磁盘） */
const repoRoot = state.data.repoRoot;
assert.ok(typeof repoRoot === 'string' && repoRoot.length > 0, 'repoRoot must resolve');
assert.equal(typeof state.data.host.bootCommit, 'string');
assert.equal(typeof state.data.host.diskCommit, 'string');
assert.equal(typeof state.data.host.startedAt, 'number');
assert.equal(state.data.lastRun, null, 'no update has run in this temp home');
const diskHead = await __internals.readDiskHead(repoRoot);
assert.ok(/^[0-9a-f]{40}$/u.test(diskHead), 'disk HEAD must be a full hash');
assert.equal(__internals.bootInfo.commit, diskHead, 'boot capture must match disk HEAD');

/* 10. P2：跨进程锁 */
const lockPath = __internals.lockFilePath(repoRoot);
rmSync(lockPath, { force: true });
const lock1 = __internals.acquireUpdateLock(repoRoot);
assert.equal(lock1.ok, true, 'first lock must succeed');
assert.equal(existsSync(lockPath), true);
const lock2 = __internals.acquireUpdateLock(repoRoot);
assert.equal(lock2.ok, false, 'second lock must fail while held');
assert.ok(String(lock2.error).includes('跨进程锁'));
__internals.releaseUpdateLock(lock1);
assert.equal(existsSync(lockPath), false, 'release must remove the lock');
// 持锁进程已死 ⇒ 自动清理过期锁
writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now(), host: 'stale' }));
assert.equal(__internals.isProcessAlive(999999), false);
const lock3 = __internals.acquireUpdateLock(repoRoot);
assert.equal(lock3.ok, true, 'stale lock must be reclaimed');
__internals.releaseUpdateLock(lock3);

/* 11. P1：状态文件往返 */
__internals.writePluginState({ testMarker: 123 });
assert.equal(__internals.readPluginState().testMarker, 123);

/* 12. P1：回滚接口的守卫（绝不真的启动回滚） */
res = await call('POST', '/dsh-version/api', { action: 'rollback', confirm: true }, { socket: { remoteAddress: '10.0.0.5' } });
assert.equal(res.status, 403);
res = await call('POST', '/dsh-version/api', { action: 'rollback' });
assert.equal(res.status, 400);
res = await call('POST', '/dsh-version/api', { action: 'rollback', confirm: true });
console.log('\n=== POST rollback without a recorded base commit (must be refused) ===');
console.log('HTTP', res.status, '|', JSON.stringify(res.data));
assert.equal(res.status, 400);
assert.ok(String(res.data.error).includes('基线提交'));
assert.equal(__internals.updateRun.running, false, 'rollback guard must not start a run');

console.log('\nall assertions passed');
