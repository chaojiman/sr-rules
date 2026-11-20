/**
 * 把本地落地节点注入「Bettbox 当前运行的覆写脚本」
 *
 * 每次运行都先拉 GitHub 最新脚本（与 Bettbox 点「同步」拿到的是同一份），
 * 再把 proxies.local.json 注入其中；拉取失败直接报错退出，不会用旧脚本糊弄过去。
 *
 * 只替换 `const customizeProxies = [...]` 段，其余逻辑原样保留。
 *
 * 用法:
 *   node scripts/inject-local-nodes.mjs [--proxies <file>] [--offline]
 *     --proxies  节点文件，默认仓库根目录 proxies.local.json
 *     --offline  不联网，直接用 Bettbox 现有脚本（临时应急用）
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const REPO_RAW = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/bettbox/mihomoScript.js';
const BETTBOX_DIR = path.join(process.env.APPDATA || '', 'com.appshub', 'Bettbox');
const argv = process.argv;
const proxiesArg = argv.indexOf('--proxies');
const LOCAL_FILE = path.resolve(proxiesArg > 0 ? argv[proxiesArg + 1] : 'proxies.local.json');
const OFFLINE = argv.includes('--offline') || argv.includes('--local');

function fail(msg) {
  console.error(`\n  FAILED: ${msg}`);
  process.exit(1);
}

// ── 1. 本地节点 ──
if (!fs.existsSync(LOCAL_FILE)) fail(`找不到节点文件 ${LOCAL_FILE}`);
let proxies;
try {
  proxies = vm.runInNewContext(`(${fs.readFileSync(LOCAL_FILE, 'utf8')})`, {});
} catch (e) {
  fail(`节点文件语法错误：${e.message}`);
}
if (!Array.isArray(proxies) || proxies.length === 0) fail('节点文件不是非空数组');
console.log(`  本地节点: ${proxies.length} 个`);
for (const p of proxies) console.log(`    - ${p.name}`);

// ── 2. 定位 Bettbox 脚本（写入目标，同时是离线源） ──
const cfgPath = path.join(BETTBOX_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fail(`找不到 ${cfgPath}`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const script = (cfg.scriptProps?.scripts || [])[0];
if (!script?.id) fail('config.json 里没有启用中的覆写脚本');
const dst = path.join(BETTBOX_DIR, 'scripts', `${script.id}.js`);
if (!fs.existsSync(dst)) fail(`找不到 Bettbox 脚本副本 ${dst}（先在 Bettbox 里点一次「同步」）`);

// ── 3. 取源脚本：默认强制拉 GitHub 最新，--offline 才用本地副本 ──
let code = null;
if (OFFLINE) {
  code = fs.readFileSync(dst, 'utf8');
  console.log('  源: Bettbox 现有脚本（--offline，未联网）');
} else {
  console.log('  拉取 GitHub 最新脚本 ...');
  try {
    const res = await fetch(REPO_RAW, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    code = await res.text();
  } catch (e) {
    fail(`拉取失败（${e.message}），脚本未改动。\n  先确保 Bettbox 已连接（7890 代理可用），或加 --offline 跳过联网`);
  }
  if (!code) fail('拉取结果为空，脚本未改动');
  const built = code.match(/^\/\/ 生成日期: (.+)$/m)?.[1];
  const upstream = code.match(/^\/\/ 上游版本: (.+)$/m)?.[1];
  console.log(`  源: GitHub 最新（${code.length} 字节）`);
  if (built || upstream) console.log(`  构建: ${built ?? '未知'} / 上游: ${upstream ?? '未知'}`);
}

// ── 4. 只替换 customizeProxies 段 ──
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
code = `${code.slice(0, start)}${injected}${code.slice(end)}`;

// ── 5. 语法校验 ──
try {
  new vm.Script(code, { filename: 'injected.js' });
} catch (e) {
  fail(`注入后语法错误：${e.message}`);
}

// ── 6. 备份 + 写入 ──
const bak = `${dst}.bak-${Date.now()}`;
// 只保留最近 2 个备份
const bakDir = path.dirname(dst);
const olds = fs.readdirSync(bakDir)
  .filter((f) => f.startsWith(path.basename(dst) + '.bak-'))
  .map((f) => ({ f, m: fs.statSync(path.join(bakDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
for (const { f } of olds.slice(1)) fs.unlinkSync(path.join(bakDir, f));
fs.copyFileSync(dst, bak);
fs.writeFileSync(dst, code, 'utf8');
console.log(`  已备份: ${path.basename(bak)}`);
console.log(`  已写入: ${dst}`);
// ── 7. Bettbox 只在切换/重启配置时重建，检查运行配置是否已跟上 ──
const profileId = cfg.currentProfileId;
const cachePath = profileId ? path.join(BETTBOX_DIR, 'relay', `cache-${profileId}.json`) : null;
const stale = Boolean(cachePath && fs.existsSync(cachePath) && fs.statSync(cachePath).mtimeMs < fs.statSync(dst).mtimeMs);
console.log('\n  完成。');
if (stale) {
  console.log('  ⚠️ Bettbox 运行配置早于本次注入：仅点「重连」不会重跑脚本。');
  console.log('     托盘退出 Bettbox 后重开（或切换一次配置再切回），新分组才会出现。');
} else {
  console.log('  运行配置已是最新，直接重连即可。');
}
console.log('  组: 链式落地 / 链式落地-<地区>；链式中转 决定前置。');