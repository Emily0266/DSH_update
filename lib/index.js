/**
 * dsh-version-panel — host half.
 *
 * 在 webServer 上注册一个精确路由，向浏览器端提供：
 *
 *   GET  /dsh-version/api              读取状态（当前版本 + 上游最新版本 + 构建态，带缓存）
 *   POST /dsh-version/api              { action: "check" }     强制重新检查上游
 *                                      { action: "update" }    启动本地更新（需 confirm: true）
 *                                      { action: "progress" }  读取更新进度
 *
 * 当前版本来自「真实运行入口」：从 process.argv[1] 向上定位最近的 package.json，
 * 因此源码部署（apps/cli/src/bin.ts）也能读到正确版本。
 * 上游版本来自 GitHub releases，失败时回退 tags 并在候选里取最大语义化版本。
 *
 * 本地更新（源码仓库）按固定顺序执行：
 *
 *   preflight（基线 HEAD + 工作区干净度）→ 暂退受管补丁（为 pull 让路）
 *   → git pull --ff-only → 重放本地补丁
 *   → pnpm install → pnpm run build（唯一规范构建入口）→ 产物校验 → 隔离冒烟自检
 *
 * 设计约束：
 *   - 所有子进程 shell: false + 显式 cwd + 解析后的绝对可执行文件（绝不裸调 pnpm）；
 *   - 包管理器统一走 corepack 解析出的声明版本（package.json 的 packageManager）；
 *   - 插件 apply 永不抛错（bundle 层插件抛错会导致整个 profile 无法启动）。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const name = 'dsh-version-panel';
export const inject = ['webServer'];

const ROUTE = '/dsh-version/api';
const REPO = 'deepseek-ai/deepseek-harness';
const REPO_URL = `https://github.com/${REPO}`;
const API_BASE = `https://api.github.com/repos/${REPO}`;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 65536;

/** 每一步保留的输出行数上限（滑动窗口，避免长构建吃光内存）。 */
const MAX_OUTPUT_LINES = 400;
/** 对外暴露的「最后 N 行」——失败步骤的真实报错一定落在这里。 */
const MAX_TAIL_LINES = 40;
/** 普通步骤超时：30 分钟（完整构建在慢机器上可能很久）。 */
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** 冒烟自检超时：没等到「已在监听」的进程最多等这么久（超时只是告警）。 */
const SMOKE_TIMEOUT_MS = 45 * 1000;
/** 冒烟自检「进运行态即成功」的判定窗口。 */
const SMOKE_ALIVE_MS = 15 * 1000;
/** 单次 git status 的脏文件上报上限。 */
const MAX_DIRTY_REPORT = 40;

/** 受管本地补丁目录（仓库之外，绝不写进 DSH 检出目录）。 */
const DEFAULT_PATCH_DIR = 'D:\\DSH_all\\Emily_Daily\\dsh-patches';
const PATCH_FILE_RE = /^\d{4}-.*\.patch$/;
/** 客户端构建记录：规范构建会先删再写，缺失即代表上次构建被中断。 */
const CLIENT_BUILD_RECORD = '.dsh-build/client-build-environment.json';
/** 期望的构建记录格式版本（不重实现其 SHA-256 摘要逻辑）。 */
const CLIENT_BUILD_FORMAT_VERSION = 1;

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
 * 通用工具：JSON 读取 / 可执行文件解析 / 子进程执行
 * ------------------------------------------------------------------ */

/**
 * 读取并解析 JSON 文件；失败返回 null（永不抛错）。
 * @param {string} path
 * @returns {any | null}
 */
function readJsonSafe(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return parsed === null || typeof parsed !== 'object' ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * 在候选绝对路径里找第一个存在的文件；找不到返回 null。
 * @param {readonly string[]} candidates
 * @returns {string | null}
 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 忽略无法探测的路径 */
    }
  }
  return null;
}

/**
 * 走 PATH（Windows 叠加 PATHEXT）解析可执行文件绝对路径。
 * @param {string} command
 * @returns {string | null}
 */
function whichCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? resolve(command) : null;
  }
  const dirs = String(process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);
  const suffixes = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)]
    : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      try {
        if (existsSync(candidate)) return resolve(candidate);
      } catch {
        /* 忽略无法探测的路径 */
      }
    }
  }
  return null;
}

/**
 * 定位 node 自带的 corepack 入口（.js，可直接用 process.execPath 执行）。
 * 只接受 .js/.mjs/.cjs：Windows 上的 corepack.cmd 在 shell:false 下无法执行，
 * 必须用 process.execPath + corepack.js 这种字面调用。
 * @returns {string | null}
 */
function resolveCorepackEntry() {
  const nodeDir = dirname(process.execPath);
  const direct = firstExisting([
    join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]);
  if (direct !== null) return direct;
  const fromPath = whichCommand('corepack.js') ?? whichCommand('corepack.mjs');
  return fromPath !== null && /\.[cm]?js$/iu.test(fromPath) ? fromPath : null;
}

/** 把 corepack 入口包装成 shell:false 可执行的字面调用。 */
function corepackInvocation(entry, args) {
  return { command: process.execPath, args: [entry, ...args] };
}

/* ------------------------------------------------------------------ *
 * 包管理器解析（corepack 优先 / npx 回退 / 声明版本把关）
 * ------------------------------------------------------------------ */

/**
 * 读取仓库 package.json 里声明的 packageManager 名字与版本。
 * @param {string} repoRoot
 * @returns {{ declared: string | null, declaredVersion: string | null, declaredName: string | null }}
 */
function readDeclaredPackageManager(repoRoot) {
  const manifest = readJsonSafe(join(repoRoot, 'package.json'));
  const raw = typeof manifest?.packageManager === 'string' ? manifest.packageManager.trim() : '';
  if (raw === '') return { declared: null, declaredVersion: null, declaredName: null };
  const match = /^(@?[^@\s]+)@(.+)$/.exec(raw);
  const declaredName = match === null ? raw : match[1];
  const declaredVersion = match === null ? null : match[2];
  return { declared: raw, declaredVersion, declaredName };
}

/**
 * 执行一段探测命令并返回 { code, output }；永不抛错。
 * @param {{ command: string, args: string[] }} invocation
 * @param {string} cwd
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function probeCommand(invocation, cwd) {
  return new Promise((resolvePromise) => {
    let child;
    const chunks = [];
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({ code: null, output: String(error?.message ?? error) });
      return;
    }
    const push = (chunk) => {
      if (chunks.length < 40) chunks.push(String(chunk));
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => resolvePromise({ code: null, output: String(error?.message ?? error) }));
    child.on('close', (code) => resolvePromise({ code, output: chunks.join('').trim() }));
  });
}

/**
 * 解析本次更新要使用的包管理器。永不抛错：失败信息收敛到 ok/message。
 * 顺序：corepack pnpm（校验 --version）→ npx -y pnpm@<声明版本> → 拒绝更新。
 * @param {string} repoRoot
 * @returns {Promise<object>}
 */
async function resolvePackageManager(repoRoot) {
  const declared = readDeclaredPackageManager(repoRoot);
  const result = {
    ok: false,
    source: null,
    command: null,
    args: [],
    /** 实际解析到的 pnpm 版本 */
    version: null,
    /** package.json 声明的 packageManager 原文，例如 pnpm@11.7.0 */
    declared: declared.declared,
    declaredVersion: declared.declaredVersion,
    declaredName: declared.declaredName,
    corepackVersion: null,
    corepackAvailable: false,
    mismatch: false,
    fallbackNote: null,
    message: null,
  };

  if (declared.declaredName !== null && declared.declaredName !== 'pnpm') {
    result.message = `package.json 声明的包管理器是 ${declared.declaredName}，本插件只支持 pnpm`;
    return result;
  }

  const corepackEntry = resolveCorepackEntry();
  if (corepackEntry !== null) {
    const versionProbe = await probeCommand(corepackInvocation(corepackEntry, ['--version']), repoRoot);
    if (versionProbe.code === 0 && versionProbe.output !== '') {
      result.corepackAvailable = true;
      result.corepackVersion = versionProbe.output.split(/\r?\n/).pop() ?? null;
      const pnpmProbe = await probeCommand(corepackInvocation(corepackEntry, ['pnpm', '--version']), repoRoot);
      if (pnpmProbe.code === 0 && pnpmProbe.output !== '') {
        const resolvedVersion = pnpmProbe.output.split(/\r?\n/).pop().trim();
        result.source = 'corepack';
        result.command = process.execPath;
        result.args = [corepackEntry, 'pnpm'];
        result.version = resolvedVersion;
        result.mismatch = declared.declaredVersion !== null && declared.declaredVersion !== resolvedVersion;
        // 版本不一致只做醒目提示，不静默继续：由面板展示 pnpmMismatch / message。
        result.message = result.mismatch
          ? `corepack 解析出的 pnpm ${resolvedVersion} 与 package.json 声明的 ${declared.declaredVersion} 不一致（已按解析出的版本继续，请留意）`
          : null;
        result.ok = true;
        return result;
      }
      result.fallbackNote = `corepack 可用（${String(result.corepackVersion)}），但解析声明的 pnpm 失败`;
    } else {
      result.fallbackNote = `corepack 探测失败（corepack --version 未通过）`;
    }
  } else {
    result.fallbackNote = '未找到 corepack 入口';
  }

  if (declared.declaredVersion !== null) {
    const npxEntry = firstExisting([
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ]);
    const npxCli = npxEntry ?? whichCommand('npx');
    if (npxCli !== null) {
      const invocation = npxCli.endsWith('.js')
        ? { command: process.execPath, args: [npxCli] }
        : { command: npxCli, args: [] };
      const probe = await probeCommand(
        { command: invocation.command, args: [...invocation.args, '-y', `pnpm@${declared.declaredVersion}`, '--version'] },
        repoRoot,
      );
      const resolvedVersion = probe.code === 0 ? (probe.output.split(/\r?\n/).pop() ?? '').trim() : '';
      if (resolvedVersion === declared.declaredVersion) {
        result.source = 'npx';
        result.command = invocation.command;
        result.args = [...invocation.args, '-y', `pnpm@${declared.declaredVersion}`];
        result.version = resolvedVersion;
        result.mismatch = false;
        result.message = `corepack 未提供声明的 pnpm@${declared.declaredVersion}（${String(result.fallbackNote)}），已改用 npx 解析到同一版本`;
        result.ok = true;
        return result;
      }
      result.message = [
        `无法获得 package.json 声明的 pnpm@${declared.declaredVersion}，已拒绝更新。`,
        `  - corepack：${String(result.fallbackNote)}`,
        `  - npx 回退：${probe.code === 0 ? `解析出 ${resolvedVersion || '(空)'}` : '执行失败'}`,
      ].join('\n');
      return result;
    }
    result.message = [
      `无法获得 package.json 声明的 pnpm@${declared.declaredVersion}，已拒绝更新。`,
      `  - corepack：${String(result.fallbackNote)}`,
      '  - npx：未找到可用的 npx 入口',
    ].join('\n');
    return result;
  }

  result.message = [
    `既没有可用的 corepack，${join(repoRoot, 'package.json')} 也没有声明 packageManager 基线，已拒绝更新。`,
    `  - corepack：${String(result.fallbackNote)}`,
  ].join('\n');
  return result;
}

/* ------------------------------------------------------------------ *
 * 受管本地补丁（D）
 * ------------------------------------------------------------------ */

/** 补丁目录（可用 DSH_VERSION_PANEL_PATCH_DIR 覆盖，便于测试与多机部署）。 */
function patchDirectory() {
  const override = process.env.DSH_VERSION_PANEL_PATCH_DIR;
  return typeof override === 'string' && override.trim().length > 0 ? resolve(override.trim()) : DEFAULT_PATCH_DIR;
}

/**
 * 列出补丁文件（NNNN-*.patch），按文件名升序。
 * @returns {{ dir: string, present: boolean, error: string | null, files: string[] }}
 */
function listPatchFiles() {
  const dir = patchDirectory();
  let present = false;
  try {
    present = existsSync(dir);
  } catch {
    present = false;
  }
  if (!present) return { dir, present: false, error: null, files: [] };
  try {
    const files = readdirSync(dir)
      .filter((entry) => PATCH_FILE_RE.test(entry))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((entry) => join(dir, entry));
    return { dir, present: true, error: null, files };
  } catch (error) {
    return { dir, present: true, error: String(error?.message ?? error), files: [] };
  }
}

/** 去掉 git 路径里可能存在的引号与转义。 */
function unquoteGitPath(raw) {
  let value = String(raw ?? '').trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
    value = value.replace(/\\(["\\])/g, '$1').replace(/\\(\d{3})/g, (all, oct) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
  }
  return value;
}

/**
 * 解析补丁头部，取出它触及的路径（+++ b/<path> / --- a/<path>），不依赖 git 自省。
 * 同时取出二进制补丁（GIT binary patch）关联的路径。
 * @param {string} file
 * @returns {{ paths: string[], error: string | null }}
 */
function parsePatchPaths(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { paths: [], error: `读取补丁失败：${String(error?.message ?? error)}` };
  }
  const paths = new Set();
  const recorded = (raw) => {
    const value = unquoteGitPath(raw).replace(/\t.*$/, '').trim();
    if (value === '' || value === '/dev/null') return;
    paths.add(value.replace(/^[ab]\//, ''));
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) recorded(line.slice(4));
    else if (line.startsWith('--- ')) recorded(line.slice(4));
    else if (line.startsWith('rename from ')) recorded(line.slice(12));
    else if (line.startsWith('rename to ')) recorded(line.slice(10));
    else if (line.startsWith('copy from ')) recorded(line.slice(10));
    else if (line.startsWith('copy to ')) recorded(line.slice(8));
    else if (line.startsWith('diff --git ')) {
      for (const match of line.slice(11).matchAll(/(?:^|\s)([ab]\/[^\s]+)/g)) recorded(match[1]);
    }
  }
  return { paths: [...paths], error: null };
}

/**
 * 汇总所有补丁触及的路径集合（用于 preflight 判定「改动是否受管」）。
 * @param {string[]} files
 * @returns {{ paths: Set<string>, errors: string[] }}
 */
function collectPatchPaths(files) {
  const paths = new Set();
  const errors = [];
  for (const file of files) {
    const parsed = parsePatchPaths(file);
    if (parsed.error !== null) {
      errors.push(`${basename(file)}：${parsed.error}`);
      continue;
    }
    for (const path of parsed.paths) paths.add(path);
  }
  return { paths, errors };
}

/** 归一化 git 路径，便于与补丁头路径比较。 */
function normalizeGitPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 从 `git apply` 输出里提取冲突文件。 */
function parseConflictFiles(output) {
  const conflicts = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const direct = /error:\s*(?:patch failed:\s*)?([^\s:]+\.(?:[A-Za-z0-9_]+)?)[:\s]/.exec(line);
    if (direct !== null && direct[1] !== undefined && /[./]/.test(direct[1])) conflicts.add(normalizeGitPath(direct[1]));
    const applying = /error:\s*(.+?):\s*(?:already exists|does not exist|patch does not apply)/i.exec(line);
    if (applying !== null) conflicts.add(normalizeGitPath(applying[1]));
    const rejected = /Applying patch .* with \d+ reject/.exec(line);
    if (rejected !== null) conflicts.add(line.trim());
  }
  return [...conflicts];
}

/* ------------------------------------------------------------------ *
 * 子进程执行（shell: false + 显式 cwd + 输出窗口）
 * ------------------------------------------------------------------ */

/**
 * 执行一步命令，收集输出。返回的 record 里：
 *   - lines：保留的最后 MAX_OUTPUT_LINES 行（有界滑动窗口）；
 *   - tail：最后 MAX_TAIL_LINES 行（始终保留，失败时最关键的报错都在这里）；
 *   - timedOut：是否被超时终止。
 * @param {{ name: string, command: string, args: string[], timeoutMs?: number }} step
 * @param {string} cwd
 * @returns {Promise<object>}
 */
function runStep(step, cwd) {
  return new Promise((resolvePromise) => {
    const record = {
      name: step.name,
      status: 'running',
      code: null,
      lines: [],
      error: null,
      startedAt: Date.now(),
      endedAt: 0,
      timedOut: false,
      outputLines: 0,
    };
    let child;
    try {
      child = spawn(step.command, step.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      record.status = 'failed';
      record.error = `启动命令失败（${step.command}）：${String(error?.message ?? error)}`;
      record.endedAt = Date.now();
      resolvePromise(record);
      return;
    }
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === '') continue;
        record.outputLines += 1;
        record.lines.push(line);
        // 有界窗口：只保留最后 MAX_OUTPUT_LINES 行
        if (record.lines.length > MAX_OUTPUT_LINES) record.lines.shift();
      }
      record.tail = record.lines.slice(-MAX_TAIL_LINES);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    let settled = false;
    const finish = (code, errorText) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      record.code = code;
      record.error = errorText;
      record.status = code === 0 && errorText === null ? 'ok' : 'failed';
      record.endedAt = Date.now();
      record.tail = record.lines.slice(-MAX_TAIL_LINES);
      resolvePromise(record);
    };
    const timer = step.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          record.timedOut = true;
          killTree(child);
          finish(null, `命令超时（${Math.round(step.timeoutMs / 1000)} 秒）`);
        }, step.timeoutMs);
    child.on('error', (error) => {
      finish(null, `子进程错误：${String(error?.message ?? error)}`);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, null));
  });
}

/** 终断子进程（Windows 下连带子进程树，避免构建残留）。 */
function killTree(child) {
  if (child === null || child === undefined) return;
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
      return;
    }
    child.kill('SIGKILL');
  } catch {
    /* 忽略终止失败 */
  }
}

/* ------------------------------------------------------------------ *
 * C：产物校验（客户端 bundle + 构建记录）
 * ------------------------------------------------------------------ */

/**
 * 枚举 packages/*\/* 下的每个包 manifest（浅扫一层目录，不做全树递归）。
 * @param {string} repoRoot
 * @returns {{ manifests: Array<{ name: string, dir: string, manifest: any }>, errors: string[] }}
 */
function walkPackageManifests(repoRoot) {
  const manifests = [];
  const errors = [];
  const packagesDir = join(repoRoot, 'packages');
  let scopes;
  try {
    scopes = readdirSync(packagesDir, { withFileTypes: true });
  } catch (error) {
    return { manifests, errors: [`无法读取 ${packagesDir}：${String(error?.message ?? error)}`] };
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(packagesDir, scope.name);
    let entries;
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(scopeDir, entry.name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readJsonSafe(manifestPath);
      if (manifest === null) {
        errors.push(`无法解析 ${manifestPath}`);
        continue;
      }
      manifests.push({
        name: typeof manifest.name === 'string' ? manifest.name : `${scope.name}/${entry.name}`,
        dir,
        manifest,
      });
    }
  }
  return { manifests, errors };
}

/**
 * 解析 exports['./client'] 里声明的构建产物路径。
 * 支持 { default } / { types } / 纯字符串三种写法。
 * @param {any} clientExport
 * @returns {string | null}
 */
function clientExportTarget(clientExport) {
  if (typeof clientExport === 'string') return clientExport;
  if (clientExport === null || typeof clientExport !== 'object') return null;
  for (const key of ['default', 'types', 'import', 'require']) {
    const value = clientExport[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * C-1：客户端 bundle 存在性校验。
 * 遍历 packages/*\/*\/package.json，凡声明 exports['./client'] 者，
 * 解析其 default（或 types）路径并断言文件存在；每个缺失都报「包名 + 期望路径」。
 * @param {string} repoRoot
 * @returns {{ ok: boolean, checked: number, missing: Array<{ package: string, expected: string, manifest: string }>, errors: string[] }}
 */
function checkClientBundles(repoRoot) {
  const { manifests, errors } = walkPackageManifests(repoRoot);
  const missing = [];
  let checked = 0;
  for (const item of manifests) {
    const clientExport = item.manifest?.exports?.['./client'];
    if (clientExport === undefined) continue;
    const target = clientExportTarget(clientExport);
    const manifestPath = join(item.dir, 'package.json');
    if (target === null) {
      errors.push(`${item.name}：exports['./client'] 没有可解析的 default/types 路径`);
      continue;
    }
    checked += 1;
    const expected = resolve(item.dir, target);
    let present = false;
    try {
      present = statSync(expected).isFile();
    } catch {
      present = false;
    }
    if (!present) {
      missing.push({ package: item.name, expected, manifest: manifestPath });
    }
  }
  return { ok: missing.length === 0 && errors.length === 0, checked, missing, errors };
}

/**
 * C-2：构建记录存在性与格式校验（不重实现其 SHA-256 摘要逻辑）。
 * 规范构建会先删除记录再重建，所以「记录缺失」等于「上次构建被中断」。
 * @param {string} repoRoot
 * @returns {object}
 */
function checkBuildRecord(repoRoot) {
  const path = join(repoRoot, ...CLIENT_BUILD_RECORD.split('/'));
  let present = false;
  try {
    present = existsSync(path);
  } catch {
    present = false;
  }
  if (!present) {
    return {
      present: false,
      path,
      formatVersion: null,
      formatOk: false,
      parseError: null,
      lastBuildIncomplete: true,
      message: '上次构建未完成：规范构建会先删除该记录再重建，记录缺失说明构建被中断（需要重新执行一次完整构建）',
    };
  }
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    parseError = String(error?.message ?? error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      present: true,
      path,
      formatVersion: null,
      formatOk: false,
      parseError: parseError ?? '构建记录不是 JSON 对象',
      lastBuildIncomplete: true,
      message: '上次构建未完成：构建记录无法解析',
    };
  }
  const formatVersion = typeof parsed.formatVersion === 'number' ? parsed.formatVersion : null;
  const formatOk = formatVersion === CLIENT_BUILD_FORMAT_VERSION;
  return {
    present: true,
    path,
    formatVersion,
    formatOk,
    parseError,
    lastBuildIncomplete: !formatOk,
    message:
      formatOk === true
        ? null
        : `构建记录格式异常：期望 formatVersion=${String(CLIENT_BUILD_FORMAT_VERSION)}，实际 ${String(formatVersion)}`,
  };
}

const bundleCheckCache = new Map();

/**
 * 带短缓存的 bundle 校验（状态轮询友好）。
 * @param {string} repoRoot
 * @param {boolean} force
 */
function checkClientBundlesCached(repoRoot, force) {
  const cached = bundleCheckCache.get(repoRoot);
  if (force !== true && cached !== undefined && Date.now() - cached.at < 5000) return cached.value;
  const value = checkClientBundles(repoRoot);
  bundleCheckCache.set(repoRoot, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ *
 * E：隔离冒烟自检
 * ------------------------------------------------------------------ */

/** 默认 DSH_HOME（无显式配置时）。 */
function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  return typeof userProfile === 'string' && userProfile.length > 0 ? join(userProfile, '.dsh') : null;
}

/**
 * 找可用的 profile：优先真实 web profile，其次任意带 dsh.profile.bundles 的 profile。
 * 返回 temp home 里需要落地的 package.json 内容（含 bundles 列表）。
 * @returns {{ ok: boolean, dir: string | null, bundles: string[], manifest: any, source: string | null, error: string | null }}
 */
function findSmokeProfile() {
  const home = defaultDshHome();
  if (home === null) return { ok: false, dir: null, bundles: [], manifest: null, source: null, error: '无法确定 DSH_HOME' };
  const profilesDir = join(home, 'profiles');
  const names = [];
  try {
    if (existsSync(join(profilesDir, 'web', 'package.json'))) names.push('web');
    for (const entry of readdirSync(profilesDir)) {
      if (entry !== 'web' && entry !== 'node_modules' && !names.includes(entry)) names.push(entry);
    }
  } catch (error) {
    return { ok: false, dir: null, bundles: [], manifest: null, source: null, error: `无法枚举 ${profilesDir}：${String(error?.message ?? error)}` };
  }
  for (const profileName of names) {
    const dir = join(profilesDir, profileName);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJsonSafe(manifestPath);
    if (manifest === null) continue;
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) continue;
    return {
      ok: true,
      dir,
      bundles: bundles.filter((item) => typeof item === 'string'),
      manifest,
      source: `${profileName}（${manifestPath}）`,
      error: null,
    };
  }
  return { ok: false, dir: null, bundles: [], manifest: null, source: null, error: '未找到任何带 dsh.profile.bundles 的 profile' };
}

/** 确保候选路径存在（真实目录或符号链接指向的真实目录）。 */
function existsAsDirectory(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return statSync(path).isDirectory();
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** 建立 junction / 符号链接；失败返回错误文本。 */
function createLink(linkPath, targetPath) {
  try {
    if (existsAsDirectory(targetPath)) {
      symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return null;
    }
    const info = statSync(targetPath);
    symlinkSync(targetPath, linkPath, info.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

/** 去掉 ANSI 颜色序列，便于在面板里展示与分类。 */
function stripAnsi(text) {
  return String(text).replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

/** 从一行日志里提取插件名（`[plugin-name] ...`）。 */
function pluginOfLine(line) {
  const match = /^\s*(?:\[|\(|（)?([@a-z0-9][\w@./-]*)(?:\]|\)|）)?\s*[:：]/.exec(stripAnsi(line));
  return match === null ? null : match[1];
}

/**
 * 按插件归类失败/告警行。
 * @param {string[]} lines
 */
function classifySmokeLines(lines) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = stripAnsi(raw).trimEnd();
    if (line.trim() === '') continue;
    if (seen.has(line)) continue;
    seen.add(line);
    const lower = line.toLowerCase();
    const isError = /\b(error|fatal|failed|failure|cannot find|not found|missing|unhandled|econnrefused|exception|throw)\b/.test(lower)
      || /\bERR_[A-Z_]+\b/.test(line);
    const isWarn = /\bwarn(ing)?\b/.test(lower) || line.includes('警告');
    if (isError) {
      errors.push(pluginOfLine(line) === null ? line : `[${pluginOfLine(line)}] ${line}`);
    } else if (isWarn) {
      warnings.push(line);
    }
  }
  return { errors: errors.slice(-MAX_TAIL_LINES), warnings: warnings.slice(-MAX_TAIL_LINES) };
}

/**
 * E：隔离冒烟自检。
 *
 * 在临时 DSH_HOME 里复制真实 web profile 的 bundles 列表（并链接其 node_modules 以获得
 * 与真实运行完全一致的包解析），以 --port 0 启动一次独立进程；进程能存活到「监听端口」
 * 即判定启动成功。绝不动 127.0.0.1:3080 上的真实服务，也绝不并发启动真实 profile 目录
 * （临时目录里只放复制出来的 package.json + 指向真实 node_modules 的链接）。
 *
 * 本函数永不抛错：跑不起来只记录原因后继续（best-effort）。
 * @param {string} repoRoot
 * @param {(record: object) => void} [onRecord] 产出步骤记录（用于进度上报）
 * @returns {Promise<object>}
 */
async function runSmokeBoot(repoRoot, onRecord) {
  const result = {
    ok: null,
    ran: false,
    skippedReason: null,
    port: null,
    /** 从启动到观测到「已监听」的毫秒数 */
    aliveMs: null,
    timeoutMs: SMOKE_TIMEOUT_MS,
    exitCode: null,
    survivedWindow: false,
    profileSource: null,
    profileBundles: [],
    command: null,
    output: '',
    errors: [],
    warnings: [],
    cleanupError: null,
    tempHome: null,
  };
  const record = {
    name: '隔离冒烟自检',
    status: 'running',
    code: null,
    lines: [],
    error: null,
    startedAt: Date.now(),
    endedAt: 0,
    timedOut: false,
    outputLines: 0,
  };
  if (typeof onRecord === 'function') onRecord(record);
  const push = (line) => {
    if (typeof line !== 'string' || line.trim() === '') return;
    record.outputLines += 1;
    record.lines.push(line);
    if (record.lines.length > MAX_OUTPUT_LINES) record.lines.shift();
    record.tail = record.lines.slice(-MAX_TAIL_LINES);
  };
  const finish = () => {
    record.endedAt = Date.now();
    record.status = result.ok === false ? 'failed' : 'ok';
    record.code = result.exitCode;
    record.error = result.skippedReason;
    record.tail = record.lines.slice(-MAX_TAIL_LINES);
    record.smoke = { ...result };
    return record;
  };

  let tempHome = null;
  try {
    const profile = findSmokeProfile();
    if (profile.ok !== true || profile.dir === null) {
      result.skippedReason = `冒烟自检跳过：${String(profile.error)}`;
      result.profileSource = null;
      push(result.skippedReason);
      return finish();
    }
    result.profileSource = profile.source;
    result.profileBundles = profile.bundles;

    const cliEntry = firstExisting([
      join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'),
      join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'),
    ]);
    if (cliEntry === null) {
      result.skippedReason = '冒烟自检跳过：未找到 CLI 入口（apps/cli/lib/bin.js）';
      push(result.skippedReason);
      return finish();
    }
    const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const useTsxLoader = cliEntry.endsWith('.ts') && existsSync(tsxLoader);

    tempHome = join(tmpdir(), `dsh-version-panel-smoke-${process.pid}-${Date.now().toString(36)}`);
    // 用 web 这个名字，这样 `dsh web` 子命令直接命中临时 profile（子命令不接受父级 --profile）。
    const smokeProfileName = 'web';
    const smokeProfileDir = join(tempHome, 'profiles', smokeProfileName);
    mkdirSync(smokeProfileDir, { recursive: true });
    const manifest = {
      name: 'dsh-profile-version-panel-smoke',
      private: true,
      dependencies: profile.manifest?.dependencies ?? {},
      dsh: { profile: { bundles: profile.bundles, patchReload: profile.manifest?.dsh?.profile?.patchReload ?? 'live' } },
    };
    writeFileSyncCompat(join(smokeProfileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
    writeFileSyncCompat(
      join(smokeProfileDir, 'cordis.yml'),
      '# dsh-version-panel 冒烟自检 profile（临时，自动清理）\n[]\n',
    );
    const sharedProfilesModules = join(dirname(profile.dir), '..', 'profiles', 'node_modules');
    const realProfileNodeModules = join(profile.dir, 'node_modules');
    let linkError = null;
    if (existsAsDirectory(realProfileNodeModules)) {
      linkError = createLink(join(smokeProfileDir, 'node_modules'), realProfileNodeModules);
    }
    if (existsAsDirectory(sharedProfilesModules)) {
      const shared = createLink(join(tempHome, 'profiles', 'node_modules'), sharedProfilesModules);
      linkError = linkError ?? shared;
    }
    if (linkError !== null) {
      push(`冒烟自检提示：建立 node_modules 链接失败（${linkError}），尝试在无外部依赖的条件下启动`);
    }
    result.tempHome = tempHome;

    const env = { ...process.env };
    env.DSH_HOME = tempHome;
    env.DSH_TELEMETRY_DISABLED = '1';
    if (env.DEEPSEEK_API_KEY === undefined || env.DEEPSEEK_API_KEY === '') env.DEEPSEEK_API_KEY = 'smoke-keyless';
    const args = [];
    if (useTsxLoader) args.push('--import', 'tsx/esm');
    // web 子命令不接受父级 --profile，因此临时 profile 直接命名为 web（$DSH_HOME/profiles/web）
    args.push(cliEntry, 'web', '--port', '0', '--no-open');
    result.command = [process.execPath, ...args].join(' ');

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: repoRoot,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      result.skippedReason = `冒烟自检跳过：启动失败 ${String(error?.message ?? error)}`;
      push(result.skippedReason);
      return finish();
    }
    result.ran = true;
    const pushChunk = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) push(line);
    };
    child.stdout?.on('data', pushChunk);
    child.stderr?.on('data', pushChunk);

    let exitCode = null;
    let exited = false;
    const exitPromise = new Promise((resolveExit) => {
      child.on('error', (error) => {
        exited = true;
        exitCode = null;
        push(`冒烟自检子进程错误：${String(error?.message ?? error)}`);
        resolveExit();
      });
      child.on('close', (code) => {
        exited = true;
        exitCode = typeof code === 'number' ? code : null;
        resolveExit();
      });
    });
    const deadline = Date.now() + SMOKE_TIMEOUT_MS;
    // 一旦日志里出现「已在 127.0.0.1:<port> 监听」，就立刻判定启动成功并结束等待，
    // 不必空等满整个超时；超时路径保留给「既不退出也不监听」的挂死场景。
    const listeningPattern = /127\.0\.0\.1:(\d+)/;
    const portOf = () => {
      const match = listeningPattern.exec(stripAnsi(record.lines.join('\n')));
      return match === null ? null : Number(match[1]);
    };
    while (!exited && portOf() === null && Date.now() - deadline < 0) {
      const remaining = deadline - Date.now();
      // 分段等待：既能感知进程退出，也能感知「已进入监听」。
      await Promise.race([exitPromise, new Promise((resolveWait) => setTimeout(resolveWait, Math.min(500, Math.max(50, remaining))))]);
    }
    const port = portOf();
    const listening = port !== null && !exited;
    if (listening) {
      result.aliveMs = Date.now() - record.startedAt;
    } else if (!exited) {
      killTree(child);
      await Promise.race([exitPromise, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
      result.timedOut = true;
      record.timedOut = true;
    }
    result.exitCode = exitCode;
    result.port = port;
    result.survivedWindow = !exited && Date.now() - record.startedAt >= SMOKE_ALIVE_MS;

    const classified = classifySmokeLines(record.lines);
    result.errors = classified.errors;
    result.warnings = classified.warnings;
    result.output = record.lines.slice(-MAX_TAIL_LINES).join('\n');

    if (listening) {
      result.ok = true;
      push(`冒烟自检通过：进程已在 127.0.0.1:${String(port)} 监听（${String(result.aliveMs)} ms）`);
    } else if (exited && !record.timedOut) {
      result.ok = false;
      push(`冒烟自检失败：进程在启动阶段退出（退出码 ${String(exitCode)}）`);
    } else if (!exited) {
      result.ok = true;
      result.warnings = [
        ...result.warnings,
        `冒烟自检在 ${Math.round(SMOKE_TIMEOUT_MS / 1000)} 秒内既未退出也未监听（判定为不阻塞更新的告警）`,
      ];
      push('冒烟自检告警：进程存活但未观测到监听（按告警处理，不影响更新结论）');
    } else {
      result.ok = true;
      push('冒烟自检在存活窗口内退出（判定为正常退出）');
    }
    return finish();
  } catch (error) {
    result.errors = [...result.errors, String(error?.message ?? error)];
    result.ok = null;
    result.skippedReason = `冒烟自检异常（不阻塞更新）：${String(error?.message ?? error)}`;
    push(result.skippedReason);
    return finish();
  } finally {
    if (tempHome !== null) {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch (cleanupError) {
        result.cleanupError = String(cleanupError?.message ?? cleanupError);
      }
    }
    result.output = record.lines.slice(-MAX_TAIL_LINES).join('\n');
  }
}

/** 写入文件（同步，冒烟自检的临时 profile 用）。 */
function writeFileSyncCompat(path, content) {
  writeFileSync(path, content, 'utf8');
}

/* ------------------------------------------------------------------ *
 * A/D：更新流水线
 * ------------------------------------------------------------------ */

const UPDATE_STEP_ORDER = [
  'preflight',
  '暂退受管补丁',
  'git pull',
  '受管本地补丁',
  'corepack pnpm install',
  'corepack pnpm run build',
  '产物校验',
  '隔离冒烟自检',
];

const updateRun = {
  running: false,
  ok: false,
  error: null,
  startedAt: 0,
  endedAt: 0,
  repoRoot: null,
  steps: [],
  /** 以下为新增字段（不改动既有字段名） */
  baseCommit: null,
  patches: [],
  patchDir: null,
  /** 已暂退、尚未重放或恢复的补丁（pull 前暂退 → pull 后重放；回滚时恢复并清空）。 */
  revertedPatches: [],
  /** 最近一次「把暂退补丁恢复回工作区」的结果（仅在回滚路径上出现）。 */
  restoreReport: null,
  packageManager: null,
  guidance: null,
  currentStep: null,
  failure: null,
};

/** 创建一步记录并登记。 */
function beginStep(stepName) {
  const record = {
    name: stepName,
    status: 'running',
    code: null,
    lines: [],
    error: null,
    startedAt: Date.now(),
    endedAt: 0,
    timedOut: false,
    outputLines: 0,
  };
  updateRun.steps.push(record);
  updateRun.currentStep = stepName;
  return record;
}

/** 把 runStep 的结果写回步骤记录。 */
function absorbStep(record, result) {
  record.status = result.status;
  record.code = result.code;
  record.lines = result.lines;
  record.tail = result.tail ?? result.lines.slice(-MAX_TAIL_LINES);
  record.error = result.error;
  record.endedAt = result.endedAt;
  record.timedOut = result.timedOut === true;
  record.outputLines = result.outputLines;
  record.durationMs = Math.max(0, record.endedAt - record.startedAt);
  return record;
}

/** 手工完成一步（不需要子进程的步骤）。 */
function completeStep(record, status, error) {
  record.status = status;
  record.code = record.code ?? null;
  record.timedOut = record.timedOut === true;
  record.error = error ?? null;
  record.endedAt = Date.now();
  record.durationMs = Math.max(0, record.endedAt - record.startedAt);
  record.tail = record.lines.slice(-MAX_TAIL_LINES);
  return record;
}

/** 把步骤 record 投影成 HTTP 载荷（保持既有字段名，追加 tail/timedOut 等新字段）。 */
function projectStep(entry) {
  return {
    name: entry.name,
    status: entry.status,
    code: entry.code,
    error: entry.error,
    lines: entry.lines.slice(-12),
    tail: (entry.tail ?? entry.lines).slice(-MAX_TAIL_LINES),
    timedOut: entry.timedOut === true,
    outputLines: entry.outputLines ?? entry.lines.length,
    durationMs: entry.durationMs ?? null,
    ...(entry.patches === undefined ? {} : { patches: entry.patches }),
    ...(entry.reverted === undefined ? {} : { reverted: entry.reverted }),
    ...(entry.restored === undefined ? {} : { restored: entry.restored }),
    ...(entry.missing === undefined ? {} : { missing: entry.missing }),
    ...(entry.conflicts === undefined ? {} : { conflicts: entry.conflicts }),
    ...(entry.record === undefined ? {} : { record: entry.record }),
    ...(entry.smoke === undefined ? {} : { smoke: entry.smoke }),
  };
}

/**
 * 解析 `git status --porcelain` 输出。
 * @param {string} output
 * @returns {{ untracked: string[], modified: Array<{ code: string, path: string, from: string | null }>, ignored: string[] }}
 */
function parseGitStatus(output) {
  const untracked = [];
  const modified = [];
  const ignored = [];
  for (const raw of String(output).split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const head = raw.slice(0, 2);
    const rest = raw.slice(3);
    if (head.startsWith('??')) {
      untracked.push(unquoteGitPath(rest));
      continue;
    }
    if (head.startsWith('!!')) {
      ignored.push(unquoteGitPath(rest));
      continue;
    }
    const code = head.trim() === '' ? 'M' : head.trim();
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) {
      modified.push({ code, from: unquoteGitPath(rest.slice(0, arrow)), path: unquoteGitPath(rest.slice(arrow + 4)) });
    } else {
      modified.push({ code, from: null, path: unquoteGitPath(rest) });
    }
  }
  return { untracked, modified, ignored };
}

/** 简单 shell 引用，便于在 guidance 里给出可直接复制的命令。 */
function quoteArg(value) {
  return /^[\w./:=@+-]+$/.test(value) ? value : `"${String(value).replace(/"/g, '\\"')}"`;
}

/** 组装可执行的手工回滚指引。 */
function rollbackGuidance(repoRoot, baseCommit, pulled) {
  const git = (args) => ['git', '-C', quoteArg(repoRoot), ...args].join(' ');
  const lines = [
    '回滚指引：',
    `  1. 查看基线：${git(['log', '--oneline', '-1', baseCommit ?? 'HEAD'])}`,
  ];
  if (pulled && baseCommit !== null) {
    lines.push(`  2. 回到更新前的提交：${git(['reset', '--hard', baseCommit])}`);
  } else {
    lines.push('  2. 未发生 git pull，工作区无需回退到旧提交。');
  }
  lines.push(
    `  3. 重新安装依赖：corepack pnpm install（cwd=${repoRoot}）`,
    `  4. 重新执行规范构建：corepack pnpm run build（cwd=${repoRoot}）`,
    '  5. 构建成功后重启 dsh web；若仍失败，用 git 提示的冲突文件手工解决后重试。',
  );
  return lines.join('\n');
}

/** 把「本次更新开始前的版本」写进状态，便于面板展示。 */
function rememberBaseCommit(commit) {
  updateRun.baseCommit = commit;
}

/**
 * 单步超时终止后的收尾：把 tail 收敛进 error，避免客户端漏掉真实报错。
 * @param {object} record
 */
function failureDetail(record) {
  const tail = (record.tail ?? record.lines).slice(-12);
  const head = record.error === null || record.error === undefined ? '' : `${record.error}\n`;
  return `${head}${tail.join('\n')}`.trim();
}

/* ------------------------------------------------------------------ *
 * 状态组装与 HTTP 处理
 * ------------------------------------------------------------------ */

/**
 * 非更新期间也要暴露的构建态（服务端可随时读取「上次构建是否完成」）。
 * @param {string | null} repoRoot
 * @param {boolean} force
 */
function describeBuildState(repoRoot, force) {
  if (repoRoot === null) {
    return {
      repoRoot: null,
      packageManager: null,
      declaredPackageManager: null,
      pnpmVersion: null,
      pnpmMismatch: false,
      pnpmSource: null,
      clientBundles: { ok: null, checked: 0, missing: [], errors: [] },
      buildRecord: { present: false, path: null, formatVersion: null, formatOk: false, parseError: null, lastBuildIncomplete: null, message: null },
      lastBuildIncomplete: null,
      smoke: updateRun.smoke ?? null,
      warnings: [],
    };
  }
  const declared = readDeclaredPackageManager(repoRoot);
  const bundles = checkClientBundlesCached(repoRoot, force);
  const buildRecord = checkBuildRecord(repoRoot);
  const warnings = [];
  if (buildRecord.lastBuildIncomplete === true) warnings.push(buildRecord.message ?? '上次构建未完成');
  if (bundles.missing.length > 0) {
    warnings.push(`客户端 bundle 缺失 ${String(bundles.missing.length)} 个：${bundles.missing.map((item) => `${item.package} → ${item.expected}`).join('；')}`);
  }
  if (bundles.errors.length > 0) warnings.push(`客户端 bundle 检查未完成：${bundles.errors.join('；')}`);
  const corepackEntry = resolveCorepackEntry();
  return {
    repoRoot,
    packageManager: declared.declared,
    declaredPackageManager: declared.declared,
    pnpmVersion: updateRun.packageManager?.version ?? null,
    pnpmMismatch: updateRun.packageManager?.mismatch === true,
    pnpmSource: updateRun.packageManager?.source ?? null,
    corepackAvailable: corepackEntry !== null,
    clientBundles: {
      ok: bundles.ok,
      checked: bundles.checked,
      missing: bundles.missing.map((item) => ({ package: item.package, expected: item.expected })),
      errors: bundles.errors,
    },
    buildRecord,
    lastBuildIncomplete: buildRecord.lastBuildIncomplete,
    smoke: updateRun.smoke ?? null,
    warnings,
  };
}

/** 组装完整状态（当前版本 + 上游 + 更新进度）。 */
async function buildState(force) {
  const manifest = locateRuntimeManifest();
  const current = manifest === null ? null : manifest.version;
  const repoRoot = manifest === null ? null : locateGitRoot(manifest.dir);
  const upstream = await upstreamCached(force);
  const latest = upstream.latest;
  const updateAvailable = current !== null && latest !== null && compareVersions(latest, current) > 0;
  const buildStateValue = describeBuildState(repoRoot, force);

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
        : 'git -C <repo> pull --ff-only && git -C <repo> apply --3way <dsh-patches/*.patch> && corepack pnpm install && corepack pnpm run build',
    packageManager: buildStateValue.packageManager,
    pnpmVersion: buildStateValue.pnpmVersion,
    pnpmMismatch: buildStateValue.pnpmMismatch,
    patchDir: patchDirectory(),
    buildState: buildStateValue,
    update: projectUpdate(),
    checkedAt: new Date().toISOString(),
  };
}

/** 把 updateRun 投影成对外载荷（字段名保持兼容）。 */
function projectUpdate() {
  return {
    running: updateRun.running,
    done: !updateRun.running && updateRun.endedAt > 0,
    success: updateRun.ok,
    error: updateRun.error,
    startedAt: updateRun.startedAt,
    endedAt: updateRun.endedAt,
    repoRoot: updateRun.repoRoot,
    steps: updateRun.steps.map(projectStep),
    /* 新增字段 */
    baseCommit: updateRun.baseCommit,
    patches: updateRun.patches,
    patchDir: updateRun.patchDir,
    revertedPatches: updateRun.revertedPatches,
    restoreReport: updateRun.restoreReport,
    packageManager: updateRun.packageManager,
    guidance: updateRun.guidance,
    currentStep: updateRun.currentStep,
    failure: updateRun.failure,
    smoke: updateRun.smoke ?? null,
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

/* ------------------------------------------------------------------ *
 * A：新流水线实现
 * ------------------------------------------------------------------ */

/**
 * 步骤 1：preflight / 基线。
 * 记录 HEAD，收集脏文件；未跟踪条目只记录；受跟踪的改动只有在「全部落在受管补丁
 * 触及的路径上」时才允许继续，否则拒绝启动更新并点名违规文件。
 */
async function stepPreflight(repoRoot) {
  const record = beginStep('preflight（基线 + 工作区检查）');
  const gitCommand = firstExisting([whichCommand('git'), 'git']) ?? 'git';

  const head = await runStep({ name: 'git rev-parse HEAD', command: gitCommand, args: ['-C', repoRoot, 'rev-parse', 'HEAD'], timeoutMs: 60000 }, repoRoot);
  record.lines.push(`$ git -C ${repoRoot} rev-parse HEAD`);
  for (const line of head.lines.slice(-6)) record.lines.push(line);
  if (head.status !== 'ok') {
    record.code = head.code;
    return completeStep(record, 'failed', `无法读取基线提交：${failureDetail(head)}`);
  }
  const baseCommit = head.lines[head.lines.length - 1]?.trim() ?? null;
  rememberBaseCommit(baseCommit);
  record.baseCommit = baseCommit;

  const status = await runStep(
    { name: 'git status --porcelain', command: gitCommand, args: ['-C', repoRoot, 'status', '--porcelain'], timeoutMs: 120000 },
    repoRoot,
  );
  record.lines.push(`$ git -C ${repoRoot} status --porcelain`);
  for (const line of status.lines.slice(-MAX_DIRTY_REPORT)) record.lines.push(line);
  if (status.status !== 'ok') {
    record.code = status.code;
    return completeStep(record, 'failed', `无法读取工作区状态：${failureDetail(status)}`);
  }

  const parsed = parseGitStatus(status.lines.join('\n'));
  const patchState = listPatchFiles();
  const managed = collectPatchPaths(patchState.files);
  updateRun.patchDir = patchState.dir;

  const outside = [];
  for (const item of parsed.modified) {
    const normalized = normalizeGitPath(item.path);
    if (!managed.paths.has(normalized)) outside.push(`${item.code} ${normalized}`);
  }

  record.untracked = parsed.untracked;
  record.modified = parsed.modified.map((item) => ({ code: item.code, path: normalizeGitPath(item.path) }));
  record.managedPaths = [...managed.paths];
  record.preflight = {
    baseCommit,
    untracked: parsed.untracked.slice(0, MAX_DIRTY_REPORT),
    untrackedCount: parsed.untracked.length,
    modified: record.modified.slice(0, MAX_DIRTY_REPORT),
    managedPaths: [...managed.paths],
    outsideManaged: outside.slice(0, MAX_DIRTY_REPORT),
    ignoredCount: parsed.ignored.length,
  };

  record.lines.push(
    `基线提交：${String(baseCommit)}`,
    `未跟踪条目 ${String(parsed.untracked.length)} 个（仅记录，不阻塞）`,
    `受跟踪改动 ${String(parsed.modified.length)} 个；受管补丁路径 ${String(managed.paths.size)} 个`,
  );
  if (parsed.untracked.length > 0) {
    for (const item of parsed.untracked.slice(0, MAX_DIRTY_REPORT)) record.lines.push(`  ?? ${item}`);
  }
  for (const item of parsed.modified.slice(0, MAX_DIRTY_REPORT)) record.lines.push(`  ${item.code} ${item.path}`);

  if (outside.length > 0) {
    record.conflicts = outside;
    const detail = [
      '受跟踪文件存在非受管改动，拒绝启动更新（避免覆盖本地工作）：',
      ...outside.slice(0, MAX_DIRTY_REPORT).map((item) => `  - ${item}`),
      '处理方式：提交 / 暂存（git stash）这些改动，或把它们移入受管补丁目录后再重试。',
    ].join('\n');
    return completeStep(record, 'failed', detail);
  }
  record.lines.push('工作区检查通过：没有不受管的受跟踪改动。');
  if (parsed.modified.length > 0) {
    record.lines.push(
      `其中 ${String(parsed.modified.length)} 个受跟踪改动落在受管补丁路径上：下一步会在 git pull 之前把它们原样暂退，pull 成功后重新应用或判定已上游化。`,
    );
  }
  return completeStep(record, 'ok', null);
}

/**
 * 把所有「已暂退但还没重放」的补丁按原样重新应用回工作区。
 *
 * 用于回滚路径：pull 失败、或暂退后仍发现无法归属的改动时，把工作区还原成更新前
 * 的样子。补丁内容由补丁文件承载，所以这里丢掉工作区改动不算丢东西；万一恢复失败，
 * 也一定把补丁文件路径报出来，让人能手工 git apply。
 *
 * @param {string} repoRoot
 * @param {string} gitCommand
 * @param {{ lines: string[] } | null} [record] 需要追加日志的步骤记录
 * @returns {Promise<{ restored: string[], failed: string[] }>}
 */
async function restoreRetreatedPatches(repoRoot, gitCommand, record = null) {
  const restored = [];
  const failed = [];
  for (const item of updateRun.revertedPatches) {
    const result = await runStep(
      {
        name: `git apply ${item.name}（恢复暂退）`,
        command: gitCommand,
        args: ['-C', repoRoot, 'apply', item.file],
        timeoutMs: 300000,
      },
      repoRoot,
    );
    if (result.status === 'ok') {
      restored.push(item.name);
      if (record !== null) record.lines.push(`  已恢复暂退补丁：${item.name}`);
    } else {
      failed.push(item.name);
      if (record !== null) {
        record.lines.push(`  恢复暂退补丁失败：${item.name}（可手工执行 git -C ${repoRoot} apply ${item.file}）`);
      }
    }
  }
  // 恢复过的东西不再处于「已暂退」状态，避免后续步骤重复处理。
  updateRun.revertedPatches = [];
  const report = { restored, failed };
  updateRun.restoreReport = report;
  return report;
}

/**
 * 步骤 2：暂退受管补丁（为 git pull 让路）。
 *
 * 受管补丁的改动一旦留在工作区，`git pull --ff-only` 在「本地改动会被覆盖」时会直接
 * 拒绝快进 —— 只要上游这次更新碰到补丁覆盖的文件，更新就必然卡死，且一步都没走成。
 * 补丁文件本身是这些改动的权威副本，所以 pull 之前先把「与某个补丁逐字一致」的工作区
 * 改动反向应用掉，pull 成功后再交给 stepPatches 重放（或判定已上游化）。
 *
 * 只暂退能被 `git apply --reverse --check` 逐字验证的改动；任何无法归属到补丁的受跟踪
 * 改动都会中止更新，并把已暂退的补丁原样恢复回工作区 —— 绝不静默丢本地工作。
 */
async function stepRetreatManagedPatches(repoRoot) {
  const record = beginStep('暂退受管补丁（为 git pull 让路）');
  const gitCommand = firstExisting([whichCommand('git'), 'git']) ?? 'git';
  const patchState = listPatchFiles();
  updateRun.patchDir = patchState.dir;
  record.reverted = [];
  updateRun.revertedPatches = [];
  updateRun.restoreReport = null;

  if (!patchState.present) {
    record.lines.push(`补丁目录不存在（${patchState.dir}），按无补丁处理。`);
    return completeStep(record, 'ok', null);
  }
  if (patchState.error !== null) {
    record.lines.push(`补丁目录读取失败：${patchState.error}`);
    return completeStep(record, 'failed', `补丁目录读取失败（${patchState.dir}）：${patchState.error}`);
  }
  if (patchState.files.length === 0) {
    record.lines.push(`补丁目录为空（${patchState.dir}），按无补丁处理。`);
    return completeStep(record, 'ok', null);
  }

  record.lines.push(`补丁目录：${patchState.dir}，共 ${String(patchState.files.length)} 个补丁`);
  for (const file of patchState.files) {
    const patchName = basename(file);
    const touched = parsePatchPaths(file).paths;
    const reverse = await runStep(
      {
        name: `git apply --reverse --check ${patchName}`,
        command: gitCommand,
        args: ['-C', repoRoot, 'apply', '--reverse', '--check', file],
        timeoutMs: 120000,
      },
      repoRoot,
    );
    if (reverse.status !== 'ok') {
      record.lines.push(`  ${patchName}：工作区未包含该改动，无需暂退`);
      continue;
    }
    const revert = await runStep(
      {
        name: `git apply --reverse ${patchName}`,
        command: gitCommand,
        args: ['-C', repoRoot, 'apply', '--reverse', file],
        timeoutMs: 300000,
      },
      repoRoot,
    );
    if (revert.status !== 'ok') {
      record.code = revert.code;
      for (const line of revert.tail ?? revert.lines.slice(-MAX_TAIL_LINES)) record.lines.push(`  ${line}`);
      const report = await restoreRetreatedPatches(repoRoot, gitCommand, record);
      record.restored = report;
      return completeStep(
        record,
        'failed',
        `暂退补丁 ${patchName} 失败（退出码 ${String(revert.code)}），已中止更新，未进入 pull 阶段：\n${failureDetail(revert)}`,
      );
    }
    record.reverted.push({ name: patchName, paths: touched });
    updateRun.revertedPatches.push({ name: patchName, file, paths: touched });
    record.lines.push(`  ${patchName}：已暂退（pull 成功后会重新应用，或判定已上游化）`);
  }

  const status = await runStep(
    { name: 'git status --porcelain', command: gitCommand, args: ['-C', repoRoot, 'status', '--porcelain'], timeoutMs: 120000 },
    repoRoot,
  );
  if (status.status !== 'ok') {
    record.code = status.code;
    record.restored = await restoreRetreatedPatches(repoRoot, gitCommand, record);
    return completeStep(record, 'failed', `暂退后无法读取工作区状态：${failureDetail(status)}`);
  }
  const parsed = parseGitStatus(status.lines.join('\n'));
  if (parsed.modified.length > 0) {
    const left = parsed.modified.map((item) => `${item.code} ${normalizeGitPath(item.path)}`);
    const report = await restoreRetreatedPatches(repoRoot, gitCommand, record);
    record.restored = report;
    record.conflicts = left;
    return completeStep(
      record,
      'failed',
      [
        '工作区里还有无法归属到任何受管补丁的受跟踪改动，拒绝继续（这种改动会让 git pull --ff-only 被 git 拒绝，而我们绝不覆盖未受管的本地工作）：',
        ...left.slice(0, MAX_DIRTY_REPORT).map((item) => `  - ${item}`),
        '处理方式：提交 / 暂存（git stash）这些改动，或把它们整理成补丁目录里的 NNNN-*.patch 后重试。',
        report.failed.length === 0
          ? `已暂退的 ${String(report.restored.length)} 个补丁已原样恢复，工作区与更新前一致。`
          : `注意：以下补丁恢复失败，请手工 git apply：${report.failed.join('、')}`,
      ].join('\n'),
    );
  }
  record.lines.push('暂退后受跟踪改动为 0，git pull --ff-only 可以快进。');
  return completeStep(record, 'ok', null);
}

/** 步骤 3：git pull --ff-only。 */
async function stepGitPull(repoRoot) {
  const record = beginStep('git pull --ff-only');
  const gitCommand = firstExisting([whichCommand('git'), 'git']) ?? 'git';
  const result = await runStep(
    { name: 'git pull --ff-only', command: gitCommand, args: ['-C', repoRoot, 'pull', '--ff-only'], timeoutMs: STEP_TIMEOUT_MS },
    repoRoot,
  );
  absorbStep(record, result);
  if (record.status !== 'ok') {
    record.error = `git pull --ff-only 失败（退出码 ${String(record.code)}）：\n${failureDetail(record)}`;
    updateRun.pulled = false;
    /* 没有拉成功就谈不上重放：把 pull 前暂退的补丁原样放回工作区，别让更新失败改变本地状态。 */
    if (updateRun.revertedPatches.length > 0) {
      const report = await restoreRetreatedPatches(repoRoot, gitCommand, record);
      record.restored = report;
      if (report.failed.length === 0) {
        record.lines.push(`已把暂退的 ${String(report.restored.length)} 个受管补丁恢复回工作区（与更新前一致）。`);
        record.error += '\n（已暂退的受管补丁已原样恢复，工作区未被改变。）';
      } else {
        record.lines.push(`以下受管补丁恢复失败，请手工 git apply：${report.failed.join('、')}`);
        record.error += `\n（暂退的受管补丁恢复失败：${report.failed.join('、')}，请手工应用补丁目录里的对应文件。）`;
      }
      record.tail = record.lines.slice(-MAX_TAIL_LINES);
    }
  } else {
    updateRun.pulled = true;
    const after = await runStep(
      { name: 'git rev-parse HEAD', command: gitCommand, args: ['-C', repoRoot, 'rev-parse', 'HEAD'], timeoutMs: 60000 },
      repoRoot,
    );
    record.headAfterPull = after.lines[after.lines.length - 1]?.trim() ?? null;
    record.lines.push(`更新后 HEAD：${String(record.headAfterPull)}`);
    record.tail = record.lines.slice(-MAX_TAIL_LINES);
  }
  return record;
}

/** 步骤 4：重放受管本地补丁（已上游化 ⇒ 跳过并记录）。 */
async function stepPatches(repoRoot) {
  const record = beginStep('重放受管本地补丁');
  const gitCommand = firstExisting([whichCommand('git'), 'git']) ?? 'git';
  const patchState = listPatchFiles();
  updateRun.patchDir = patchState.dir;
  record.patches = [];
  if (!patchState.present) {
    record.lines.push(`补丁目录不存在（${patchState.dir}），按无补丁处理。`);
    return completeStep(record, 'ok', null);
  }
  if (patchState.error !== null) {
    record.lines.push(`补丁目录读取失败：${patchState.error}`);
    return completeStep(record, 'failed', `补丁目录读取失败（${patchState.dir}）：${patchState.error}`);
  }
  if (patchState.files.length === 0) {
    record.lines.push(`补丁目录为空（${patchState.dir}），按无补丁处理。`);
    return completeStep(record, 'ok', null);
  }
  record.lines.push(`补丁目录：${patchState.dir}，共 ${String(patchState.files.length)} 个补丁`);
  for (const file of patchState.files) {
    const patchName = basename(file);
    const parsed = parsePatchPaths(file);
    const touched = parsed.paths;
    record.lines.push(`--- ${patchName}（触及 ${String(touched.length)} 个路径）`);
    const reverse = await runStep(
      { name: `git apply --reverse --check ${patchName}`, command: gitCommand, args: ['-C', repoRoot, 'apply', '--reverse', '--check', file], timeoutMs: 120000 },
      repoRoot,
    );
    if (reverse.status === 'ok') {
      // 工作区已经带上这个改动了。但这有两种完全不同的原因，必须区分开，
      // 否则会对着一个纯粹的本机未提交改动谎报「已上游化」：
      //   索引 reverse-check 也通过 ⇒ 改动确实已经进了 HEAD（上游已包含）
      //   索引 reverse-check 不通过 ⇒ 只是工作区里带着它（本地改动），HEAD 里没有
      // 未暂存任何东西时索引即 HEAD，所以这一个判断就够，无需 checkout。
      const inHead = await runStep(
        { name: `git apply --reverse --check --cached ${patchName}`, command: gitCommand, args: ['-C', repoRoot, 'apply', '--reverse', '--check', '--cached', file], timeoutMs: 120000 },
        repoRoot,
      );
      const upstreamed = inHead.status === 'ok';
      const entry = {
        name: patchName,
        status: upstreamed ? 'upstreamed' : 'present',
        code: 0,
        message: upstreamed ? '已上游化' : '工作区已包含该改动',
        paths: touched,
      };
      record.patches.push(entry);
      updateRun.patches.push(entry);
      /* 这个补丁已经处理完（结果是「不用再管」），不再算「已暂退待处理」。 */
      updateRun.revertedPatches = updateRun.revertedPatches.filter((item) => item.name !== patchName);
      record.lines.push(upstreamed
        ? `  ${patchName}：已上游化（索引 reverse --check 通过），跳过`
        : `  ${patchName}：工作区已包含该改动（HEAD 里没有，属本地未提交改动），跳过重放`);
      continue;
    }
    const apply = await runStep(
      { name: `git apply --3way ${patchName}`, command: gitCommand, args: ['-C', repoRoot, 'apply', '--3way', file], timeoutMs: 300000 },
      repoRoot,
    );
    if (apply.status !== 'ok') {
      const conflicts = parseConflictFiles(apply.lines.join('\n'));
      const unmerged = await runStep(
        { name: 'git diff --name-only --diff-filter=U', command: gitCommand, args: ['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], timeoutMs: 60000 },
        repoRoot,
      );
      const unmergedFiles = unmerged.status === 'ok' ? unmerged.lines.map(normalizeGitPath).filter((item) => item !== '') : [];
      const allConflicts = [...new Set([...unmergedFiles, ...conflicts])];
      const entry = {
        name: patchName,
        status: 'conflict',
        code: apply.code,
        message: '应用失败',
        paths: touched,
        conflicts: allConflicts,
      };
      record.patches.push(entry);
      updateRun.patches.push(entry);
      record.conflicts = allConflicts;
      record.code = apply.code;
      for (const line of apply.tail ?? apply.lines.slice(-MAX_TAIL_LINES)) record.lines.push(`  ${line}`);
      return completeStep(
        record,
        'failed',
        [
          `补丁 ${patchName} 应用失败（退出码 ${String(apply.code)}），已中止整个更新，未进入构建阶段。`,
          allConflicts.length === 0 ? '未能从输出中解析出冲突文件，请人工检查下面的输出。' : '冲突文件：',
          ...allConflicts.map((item) => `  - ${item}`),
          '',
          '若该补丁描述的问题已经由上游用别的写法修掉（HEAD 里已有等价修复），说明这个补丁该退役了：',
          `把它移出补丁目录（改名加后缀或挪进 retired 子目录，例如 ${patchName}.upstreamed）后重试即可。`,
          '',
          failureDetail(apply),
        ].join('\n'),
      );
    }
    const entry = { name: patchName, status: 'applied', code: 0, message: '已应用', paths: touched };
    record.patches.push(entry);
    updateRun.patches.push(entry);
    updateRun.revertedPatches = updateRun.revertedPatches.filter((item) => item.name !== patchName);
    record.lines.push(`  ${patchName}：已应用（--3way）`);
  }
  return completeStep(record, 'ok', null);
}

/** 步骤 5：corepack pnpm install。 */
async function stepInstall(repoRoot, packageManager) {
  const record = beginStep('corepack pnpm install');
  const result = await runStep(
    {
      name: 'corepack pnpm install',
      command: packageManager.command,
      args: [...packageManager.args, 'install'],
      timeoutMs: STEP_TIMEOUT_MS,
    },
    repoRoot,
  );
  absorbStep(record, result);
  if (record.status !== 'ok') record.error = `依赖安装失败（退出码 ${String(record.code)}）：\n${failureDetail(record)}`;
  return record;
}

/** 步骤 6：corepack pnpm run build（唯一规范构建入口）。 */
async function stepBuild(repoRoot, packageManager) {
  const record = beginStep('corepack pnpm run build（规范构建）');
  const result = await runStep(
    {
      name: 'corepack pnpm run build',
      command: packageManager.command,
      args: [...packageManager.args, 'run', 'build'],
      timeoutMs: STEP_TIMEOUT_MS,
    },
    repoRoot,
  );
  absorbStep(record, result);
  if (record.status !== 'ok') record.error = `规范构建失败（退出码 ${String(record.code)}）：\n${failureDetail(record)}`;
  else bundleCheckCache.delete(repoRoot);
  return record;
}

/** 步骤 7：产物校验（客户端 bundle + 构建记录）。 */
async function stepVerifyArtifacts(repoRoot) {
  const record = beginStep('产物校验（客户端 bundle + 构建记录）');
  const bundles = checkClientBundles(repoRoot);
  const buildRecord = checkBuildRecord(repoRoot);
  bundleCheckCache.set(repoRoot, { at: Date.now(), value: bundles });
  record.missing = bundles.missing;
  record.record = buildRecord;
  record.lines.push(`客户端 bundle：检查 ${String(bundles.checked)} 个声明 exports['./client'] 的包`);
  if (bundles.missing.length > 0) {
    for (const item of bundles.missing) record.lines.push(`  缺失：${item.package} → ${item.expected}`);
  } else {
    record.lines.push('  全部存在。');
  }
  for (const error of bundles.errors) record.lines.push(`  解析告警：${error}`);
  record.lines.push(`构建记录：${buildRecord.path}（存在=${String(buildRecord.present)}，formatVersion=${String(buildRecord.formatVersion)}）`);
  if (buildRecord.message !== null) record.lines.push(`  ${buildRecord.message}`);

  const problems = [];
  if (bundles.missing.length > 0) {
    problems.push(
      `客户端 bundle 缺失 ${String(bundles.missing.length)} 个：`,
      ...bundles.missing.map((item) => `  - ${item.package} → 期望路径 ${item.expected}`),
    );
  }
  if (bundles.errors.length > 0) problems.push('bundle 解析告警：', ...bundles.errors.map((item) => `  - ${item}`));
  if (buildRecord.lastBuildIncomplete === true) problems.push(`构建记录异常：${String(buildRecord.message)}`);
  if (problems.length > 0) {
    record.code = null;
    return completeStep(record, 'failed', `产物校验未通过，本次更新判定为失败：\n${problems.join('\n')}`);
  }
  return completeStep(record, 'ok', null);
}

/** 步骤 8：隔离冒烟自检（best-effort，超时仅告警）。 */
async function stepSmoke(repoRoot) {
  const record = await runSmokeBoot(repoRoot);
  updateRun.smoke = record.smoke ?? null;
  return record;
}

/**
 * 按顺序执行完整更新流程。
 * 任何一步失败立即中止，并把「哪一步 / 退出码 / 真实输出尾部 / 回滚指引」一起上报。
 */
async function runUpdate(repoRoot) {
  updateRun.running = true;
  updateRun.ok = false;
  updateRun.error = null;
  updateRun.startedAt = Date.now();
  updateRun.endedAt = 0;
  updateRun.repoRoot = repoRoot;
  updateRun.steps = [];
  updateRun.baseCommit = null;
  updateRun.patches = [];
  updateRun.revertedPatches = [];
  updateRun.restoreReport = null;
  updateRun.guidance = null;
  updateRun.failure = null;
  updateRun.packageManager = null;
  updateRun.pulled = false;
  updateRun.smoke = null;
  bundleCheckCache.delete(repoRoot);

  try {
    /* B：解析包管理器（一次），失败则直接拒绝更新 */
    const packageManager = await resolvePackageManager(repoRoot);
    updateRun.packageManager = packageManager;
    if (packageManager.ok !== true) {
      updateRun.error = `包管理器解析失败，已拒绝更新：${String(packageManager.message)}`;
      updateRun.failure = { step: 'packageManager', code: null, tail: [], message: updateRun.error };
      updateRun.guidance = rollbackGuidance(repoRoot, null, false);
      return;
    }

    const fail = (record) => {
      const detail = failureDetail(record);
      updateRun.error = [
        `步骤「${record.name}」失败（${record.code === null ? '无退出码' : `退出码 ${String(record.code)}`}）`,
        detail,
        record.timedOut === true ? '（该步骤因超时被终止）' : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
      updateRun.failure = {
        step: record.name,
        code: record.code,
        timedOut: record.timedOut === true,
        tail: (record.tail ?? record.lines).slice(-MAX_TAIL_LINES),
        missing: record.missing,
        conflicts: record.conflicts,
        record: record.record,
      };
    };

    const preflight = await stepPreflight(repoRoot);
    if (preflight.status !== 'ok') {
      fail(preflight);
      return;
    }

    /* 受管补丁的工作区改动必须先让路，否则 git pull --ff-only 会被 git 拒绝覆盖。 */
    const retreated = await stepRetreatManagedPatches(repoRoot);
    if (retreated.status !== 'ok') {
      fail(retreated);
      return;
    }

    const pulled = await stepGitPull(repoRoot);
    if (pulled.status !== 'ok') {
      fail(pulled);
      return;
    }

    const patches = await stepPatches(repoRoot);
    if (patches.status !== 'ok') {
      fail(patches);
      return;
    }

    const installed = await stepInstall(repoRoot, packageManager);
    if (installed.status !== 'ok') {
      fail(installed);
      return;
    }

    const built = await stepBuild(repoRoot, packageManager);
    if (built.status !== 'ok') {
      fail(built);
      return;
    }

    const verified = await stepVerifyArtifacts(repoRoot);
    if (verified.status !== 'ok') {
      fail(verified);
      return;
    }

    /* E：冒烟自检是 best-effort，不阻塞更新结论 */
    const smoke = await stepSmoke(repoRoot);
    updateRun.smoke = smoke.smoke ?? null;

    updateRun.ok = true;
  } catch (error) {
    updateRun.ok = false;
    updateRun.error = `更新流程异常：${String(error?.message ?? error)}`;
    updateRun.failure = { step: updateRun.currentStep, code: null, tail: [], message: updateRun.error };
  } finally {
    if (updateRun.ok !== true && updateRun.guidance === null) {
      updateRun.guidance = rollbackGuidance(repoRoot, updateRun.baseCommit, updateRun.pulled === true);
    }
    updateRun.currentStep = null;
    updateRun.running = false;
    updateRun.endedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 路由
 * ------------------------------------------------------------------ */

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
        sendJson(res, 200, { ok: true, ...projectUpdate() });
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
        /* 先在请求内解析包管理器，解析失败直接拒绝启动（避免半个更新流程） */
        const packageManager = await resolvePackageManager(repoRoot);
        updateRun.packageManager = packageManager;
        if (packageManager.ok !== true) {
          sendJson(res, 400, {
            ok: false,
            error: `包管理器解析失败，已拒绝更新：${String(packageManager.message)}`,
            packageManager,
          });
          return;
        }
        void runUpdate(repoRoot);
        sendJson(res, 200, {
          ok: true,
          started: true,
          repoRoot,
          packageManager,
          patches: listPatchFiles().files.map((file) => basename(file)),
          steps: UPDATE_STEP_ORDER,
        });
        return;
      }

      sendJson(res, 400, { ok: false, error: `未知 action：${action}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

/** 插件入口：注册精确 HTTP 路由。apply 永不抛错。 */
export function apply(ctx) {
  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createHandler() }),
      `dsh-version-panel: ${ROUTE} route`,
    );
  } catch (error) {
    try {
      ctx.logger?.warn?.(`dsh-version-panel: 注册路由失败（已忽略）：${String(error?.message ?? error)}`);
    } catch {
      /* 连日志都不可用时静默，绝不向上抛错 */
    }
  }
}

/**
 * 仅供离线测试使用的内部钩子（DSH bundle 只消费 apply/name/inject，不会加载它）。
 * 让产物校验与补丁状态逻辑可以针对临时夹具树被独立验证。
 */
export const __internals = {
  checkClientBundles,
  checkBuildRecord,
  describeBuildState,
  parseGitStatus,
  parsePatchPaths,
  collectPatchPaths,
  listPatchFiles,
  parseConflictFiles,
  resolvePackageManager,
  runSmokeBoot,
  runStep,
  stepPatches,
  stepPreflight,
  stepGitPull,
  stepRetreatManagedPatches,
  restoreRetreatedPatches,
  stepVerifyArtifacts,
  runUpdate,
  updateRun,
  clientExportTarget,
  ROUTE,
};
