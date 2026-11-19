/**
 * 把本地落地节点注入「Bettbox 当前运行的覆写脚本」
 *
 * 流程：
 *   1. 从 GitHub 拉最新 bettbox/mihomoScript.js（与 Bettbox 点「同步」拉到的是同一份）
 *   2. 只替换其中的 `const customizeProxies = [...]` 段，其余逻辑原样保留
 *   3. 写入 %APPDATA%\com.appshub\Bettbox\scripts\<config.json 里的脚本 id>.js
 *   4. 重启 / 重连 Bettbox 后生效
 *
 * 节点来源：仓库根目录 proxies.local.json（已 gitignore；允许 JSON 或 JS 对象字面量）
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const REPO_RAW = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/bettbox/mihomoScript.js';
const LOCAL_FILE = path.resolve('proxies.local.json');
const BETTBOX_DIR = path.join(process.env.APPDATA || '', 'com.appshub', 'Bettbox');

function fail(msg) {
  console.error(`\n  FAILED: ${msg}`);
  process.exit(1);
}

// ── 1. 本地节点 ──
if (!fs.existsSync(LOCAL_FILE)) fail(`找不到 ${LOCAL_FILE}`);
let proxies;
try {
  proxies = vm.runInNewContext(`(${fs.readFileSync(LOCAL_FILE, 'utf8')})`, {});
} catch (e) {
  fail(`proxies.local.json 语法错误：${e.message}`);
}
if (!Array.isArray(proxies) || proxies.length === 0) fail('proxies.local.json 不是非空数组');
console.log(`  本地节点: ${proxies.length} 个`);
for (const p of proxies) console.log(`    - ${p.name}`);

// ── 2. 拉最新脚本 ──
console.log('  拉取 GitHub 上的 mihomoScript.js ...');
const res = await fetch(REPO_RAW, { signal: AbortSignal.timeout(60000) });
if (!res.ok) fail(`下载失败 HTTP ${res.status}（检查代理：HTTPS_PROXY / NODE_USE_ENV_PROXY）`);
let code = await res.text();
console.log(`  已下载: ${code.length} 字节`);

// ── 3. 只替换 customizeProxies 段 ──
const anchor = code.match(/^const customizeProxies = \[/m);
if (!anchor) fail('脚本里找不到 const customizeProxies = [，上游结构可能变了');
const start = anchor.index + anchor[0].length - 1;
let depth = 0;
let end = -1;
for (let i = start; i < code.length; i += 1) {
  if (code[i] === '[') depth += 1;
  else if (code[i] === ']') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) fail('customizeProxies 数组括号不配对');
const injected = `[\n${proxies.map((p) => `  ${JSON.stringify(p)}`).join(',\n')},\n]`;
code = `${code.slice(0, start)}${injected}${code.slice(end + 1)}`;

// ── 4. 语法校验 ──
try {
  new vm.Script(code, { filename: 'injected.js' });
} catch (e) {
  fail(`注入后语法错误：${e.message}`);
}

// ── 5. 定位 Bettbox 脚本文件 ──
const cfgPath = path.join(BETTBOX_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fail(`找不到 ${cfgPath}`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const script = (cfg.scriptProps?.scripts || [])[0];
if (!script?.id) fail('config.json 里没有启用中的覆写脚本');
const dst = path.join(BETTBOX_DIR, 'scripts', `${script.id}.js`);

// ── 6. 备份 + 写入 ──
if (fs.existsSync(dst)) {
  const bak = `${dst}.bak-${Date.now()}`;
  fs.copyFileSync(dst, bak);
  console.log(`  已备份: ${path.basename(bak)}`);
}
fs.writeFileSync(dst, code, 'utf8');
console.log(`  已写入: ${dst}`);

console.log('\n  完成。重启 Bettbox（或代理页「重连」）后生效。');
console.log('  组结构应为: 链式落地 / 链式落地-<地区>；链式中转 决定前置。');