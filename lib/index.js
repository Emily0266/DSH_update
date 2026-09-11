/**
 * dsh-version-panel — host half.
 *
 * 在 webServer 上注册一个精确路由，向浏览器端提供：
 *
 *   GET  /dsh-version/api              读取状态（当前版本 + 上游最新版本，带缓存）
 *   POST /dsh-version/api              { action: "check" }     强制重新检查上游
 *                                      { action: "update" }    启动本地更新（需 confirm: true）
 *                                      { action: "progress" }  读取更新进度
 *
 * 当前版本来自「真实运行入口」：从 process.argv[1] 向上定位最近的 package.json，
 * 因此源码部署（apps/cli/src/bin.ts）也能读到正确版本。
 * 上游版本来自 GitHub releases，失败时回退 tags 并在候选里取最大语义化版本。
 * 本地更新仅对 git 源码仓库开放，按 git pull → pnpm install → build:lib → build:web 顺序执行。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const name = 'dsh-version-panel';
export const inject = ['webServer'];

const ROUTE = '/dsh-version/api';
const REPO = 'deepseek-ai/deepseek-harness';
const REPO_URL = `https://github.com/${REPO}`;
const API_BASE = `https://api.github.com/repos/${REPO}`;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LINES = 40;
const MAX_BODY_BYTES = 65536;

/* ------------------------------------------------------------------ *
 * 当前版本：从运行入口向上定位 package.json
 * ------------------------------------------------------------------ */

/**
 * 定位真实运行中的 DSH manifest。
 * @returns {null | { version: string, name: string | null, dir: string, manifestPath: string }}
 */
function locateRuntimeManifest() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return null;
  let dir;
  try {
    dir = dirname(resolve(entry));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest?.version === 'string' && /\d+\.\d+\.\d+/.test(manifest.version)) {
          return {
            version: manifest.version,
            name: typeof manifest.name === 'string' ? manifest.name : null,
            dir,
            manifestPath,
          };
        }
      } catch {
        /* 继续向上找 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 从起点向上查找 git 仓库根目录。
 * @param {string | null | undefined} start
 * @returns {string | null}
 */
function locateGitRoot(start) {
  if (typeof start !== 'string' || start.length === 0) return null;
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 语义化版本比较（含 prerelease）
 * ------------------------------------------------------------------ */

/** 解析版本号为可比较结构。 */
function parseVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** 比较 prerelease 段：无 prerelease 视为更高。 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left) ? Number(left) : null;
    const rightNum = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNum !== null && rightNum !== null) return leftNum < rightNum ? -1 : 1;
    if (leftNum !== null) return -1;
    if (rightNum !== null) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** 比较两个版本：a<b 返回 -1，相等 0，a>b 返回 1。 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.pre, right.pre);
}

/** 从 tag 名提取版本号。 */
function versionFromTag(tag) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(String(tag ?? ''));
  return match === null ? null : match[1];
}

/* ------------------------------------------------------------------ *
 * 上游检查（GitHub）
 * ------------------------------------------------------------------ */

/** 请求 GitHub JSON API；非 2xx 抛错。 */
async function githubJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'User-Agent': 'dsh-version-panel',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

/**
 * 读取上游最新版本；优先 releases，回退 tags，并在候选里取最大语义化版本。
 * 永不抛错，失败信息收敛到 error 字段。
 */
async function fetchUpstream() {
  const result = {
    latest: null,
    releaseTag: null,
    releaseUrl: null,
    releaseNotes: null,
    publishedAt: null,
    prerelease: false,
    source: null,
    candidates: [],
    error: null,
  };

  const candidates = [];
  let source = null;
  let lastError = null;

  try {
    const releases = await githubJson('/releases?per_page=30');
    if (Array.isArray(releases)) {
      for (const release of releases) {
        const version = versionFromTag(release?.tag_name);
        if (version === null) continue;
        candidates.push({
          version,
          tag: release.tag_name,
          notes: typeof release.body === 'string' ? release.body : '',
          url: typeof release.html_url === 'string' ? release.html_url : `${REPO_URL}/releases`,
          publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
          prerelease: release.prerelease === true,
        });
      }
      if (candidates.length > 0) source = 'releases';
    }
  } catch (error) {
    lastError = String(error?.message ?? error);
  }

  if (candidates.length === 0) {
    try {
      const tags = await githubJson('/tags?per_page=50');
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          const version = versionFromTag(tag?.name);
          if (version === null) continue;
          candidates.push({
            version,
            tag: tag.name,
            notes: '',
            url: `${REPO_URL}/releases/tag/${encodeURIComponent(tag.name)}`,
            publishedAt: null,
            prerelease: /-(?:alpha|beta|rc|next|pre)/i.test(version),
          });
        }
      }
      if (candidates.length > 0) {
        source = 'tags';
        lastError = null;
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
  }

  if (candidates.length === 0) {
    result.error = lastError ?? 'GitHub 未返回可用版本';
    return result;
  }

  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const best = candidates[0];
  result.latest = best.version;
  result.releaseTag = best.tag;
  result.releaseUrl = best.url;
  result.releaseNotes = best.releaseNotes;
  result.publishedAt = best.publishedAt;
  result.prerelease = best.prerelease;
  result.source = source;
  result.candidates = candidates.slice(0, 8).map((item) => item.version);
  return result;
}

/* ------------------------------------------------------------------ *
 * 上游缓存
 * ------------------------------------------------------------------ */

let upstreamCache = { at: 0, value: null };
let upstreamInflight = null;

/** 带缓存（默认 5 分钟）与并发去重的上游查询。 */
async function upstreamCached(force) {
  if (force !== true && upstreamCache.value !== null && Date.now() - upstreamCache.at < CACHE_TTL_MS) {
    return upstreamCache.value;
  }
  if (upstreamInflight !== null) return upstreamInflight;
  upstreamInflight = fetchUpstream()
    .then((value) => {
      upstreamCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      upstreamInflight = null;
    });
  return upstreamInflight;
}

/* ------------------------------------------------------------------ *
 * 本地更新
 * ------------------------------------------------------------------ */

const UPDATE_STEPS = [
  { name: 'git pull', file: 'git', args: ['pull', '--ff-only'] },
  { name: 'pnpm install', file: 'pnpm', args: ['install'] },
  { name: 'build:lib', file: 'pnpm', args: ['run', 'build:lib'] },
  { name: 'build:web', file: 'pnpm', args: ['run', 'build:web'] },
];

const updateRun = {
  running: false,
  ok: false,
  error: null,
  startedAt: 0,
  endedAt: 0,
  repoRoot: null,
  steps: [],
};

/** 在指定目录执行一步命令，收集输出。 */
function runStep(step, cwd) {
  return new Promise((resolvePromise) => {
    const record = { name: step.name, status: 'running', code: null, lines: [], error: null };
    let child;
    try {
      child = spawn(step.file, step.args, { cwd, shell: true, windowsHide: true });
    } catch (error) {
      record.status = 'failed';
      record.error = String(error?.message ?? error);
      resolvePromise(record);
      return;
    }
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === '') continue;
        record.lines.push(line);
        if (record.lines.length > MAX_OUTPUT_LINES) record.lines.shift();
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      record.status = 'failed';
      record.error = String(error?.message ?? error);
      resolvePromise(record);
    });
    child.on('close', (code) => {
      record.code = code;
      record.status = code === 0 ? 'ok' : 'failed';
      resolvePromise(record);
    });
  });
}

/** 按顺序执行完整更新流程。 */
async function runUpdate(repoRoot) {
  updateRun.running = true;
  updateRun.ok = false;
  updateRun.error = null;
  updateRun.startedAt = Date.now();
  updateRun.endedAt = 0;
  updateRun.repoRoot = repoRoot;
  updateRun.steps = [];
  try {
    for (const step of UPDATE_STEPS) {
      const record = await runStep(step, repoRoot);
      updateRun.steps.push(record);
      if (record.status !== 'ok') {
        updateRun.error = `步骤「${step.name}」失败（退出码 ${String(record.code)}）`;
        break;
      }
    }
    updateRun.ok = updateRun.error === null;
  } catch (error) {
    updateRun.error = String(error?.message ?? error);
  } finally {
    updateRun.running = false;
    updateRun.endedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ *
 * 状态组装与 HTTP 处理
 * ------------------------------------------------------------------ */

/** 组装完整状态（当前版本 + 上游 + 更新进度）。 */
async function buildState(force) {
  const manifest = locateRuntimeManifest();
  const current = manifest === null ? null : manifest.version;
  const repoRoot = manifest === null ? null : locateGitRoot(manifest.dir);
  const upstream = await upstreamCached(force);
  const latest = upstream.latest;
  const updateAvailable = current !== null && latest !== null && compareVersions(latest, current) > 0;

  return {
    ok: true,
    current,
    currentName: manifest === null ? null : manifest.name,
    currentDir: manifest === null ? null : manifest.dir,
    latest,
    latestTag: upstream.releaseTag,
    updateAvailable,
    upstreamSource: upstream.source,
    upstreamError: upstream.error,
    upstreamCandidates: upstream.candidates,
    releaseUrl: upstream.releaseUrl ?? `${REPO_URL}/releases`,
    releaseNotes: upstream.releaseNotes,
    publishedAt: upstream.publishedAt,
    prerelease: upstream.prerelease,
    repoRoot,
    installType: repoRoot === null ? 'package' : 'source-repo',
    updateCommand:
      repoRoot === null
        ? null
        : 'git pull && pnpm install && pnpm run build:lib && pnpm run build:web',
    checkedAt: new Date().toISOString(),
    update: {
      running: updateRun.running,
      done: !updateRun.running && updateRun.endedAt > 0,
      success: updateRun.ok,
      error: updateRun.error,
      startedAt: updateRun.startedAt,
      endedAt: updateRun.endedAt,
      repoRoot: updateRun.repoRoot,
      steps: updateRun.steps.map((entry) => ({
        name: entry.name,
        status: entry.status,
        code: entry.code,
        error: entry.error,
        lines: entry.lines.slice(-12),
      })),
    },
  };
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 读取并解析 JSON 请求体（上限 64KB）。 */
function readJsonBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({});
        return;
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** 创建路由处理器。 */
function createHandler() {
  return async (req, res) => {
    try {
      const method = req.method ?? 'GET';

      if (method === 'GET') {
        let force = false;
        try {
          const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
          force = url.searchParams.get('force') === '1';
        } catch {
          /* 使用默认值 */
        }
        sendJson(res, 200, await buildState(force));
        return;
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '仅支持 GET / POST' });
        return;
      }

      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const action = typeof body.action === 'string' ? body.action : '';

      if (action === 'check') {
        sendJson(res, 200, await buildState(true));
        return;
      }

      if (action === 'progress') {
        sendJson(res, 200, {
          ok: true,
          running: updateRun.running,
          done: !updateRun.running && updateRun.endedAt > 0,
          success: updateRun.ok,
          error: updateRun.error,
          startedAt: updateRun.startedAt,
          endedAt: updateRun.endedAt,
          repoRoot: updateRun.repoRoot,
          steps: updateRun.steps.map((entry) => ({
            name: entry.name,
            status: entry.status,
            code: entry.code,
            error: entry.error,
            lines: entry.lines.slice(-12),
          })),
        });
        return;
      }

      if (action === 'update') {
        if (updateRun.running) {
          sendJson(res, 409, { ok: false, error: '已有更新任务正在运行' });
          return;
        }
        const manifest = locateRuntimeManifest();
        const repoRoot = manifest === null ? null : locateGitRoot(manifest.dir);
        if (repoRoot === null) {
          sendJson(res, 400, { ok: false, error: '未找到 git 仓库根目录，无法执行本地更新' });
          return;
        }
        if (body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: '需要 confirm: true 才会执行更新' });
          return;
        }
        void runUpdate(repoRoot);
        sendJson(res, 200, {
          ok: true,
          started: true,
          repoRoot,
          steps: UPDATE_STEPS.map((step) => step.name),
        });
        return;
      }

      sendJson(res, 400, { ok: false, error: `未知 action：${action}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

/** 插件入口：注册精确 HTTP 路由。 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createHandler() }),
    `dsh-version-panel: ${ROUTE} route`,
  );
}
