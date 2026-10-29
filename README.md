# sr-rules

一套自建的代理规则仓库：**小火箭配置** + **Bettbox 覆写脚本**，每天自动跟随上游更新。

规则内容来自 [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules)（v2fly geosite/geoip）与
[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)。

---

## 📦 两个产物

| 产物 | 地址 | 用在哪 |
| --- | --- | --- |
| 小火箭配置 | [`shadowrocket/config.conf`](shadowrocket/config.conf) | iPhone / Shadowrocket |
| Bettbox 脚本 | [`bettbox/mihomoScript.js`](bettbox/mihomoScript.js) | Windows / Bettbox |

```
https://raw.githubusercontent.com/chaojiman/sr-rules/main/shadowrocket/config.conf
https://raw.githubusercontent.com/chaojiman/sr-rules/main/bettbox/mihomoScript.js
```

> 大陆拉不动 `raw.githubusercontent.com` 时，把 `https://raw.githubusercontent.com/chaojiman/sr-rules/main/`
> 换成 `https://cdn.jsdelivr.net/gh/chaojiman/sr-rules@main/`

---

## 📁 目录结构

```
sr-rules/
├── shadowrocket/               小火箭
│   ├── config.conf             完整配置（分组 + 规则）
│   └── rules/*.list            21 个规则集
├── bettbox/                    Bettbox
│   ├── mihomoScript.js         生成的覆写脚本
│   └── rules-extra.txt         ★ 手改这里加临时规则
├── scripts/                    构建脚本
│   ├── build-shadowrocket.mjs  上游规则集 → 小火箭格式
│   └── build-bettbox.mjs       上游脚本 + 补丁 → 覆写脚本
├── .github/workflows/
│   ├── sync-shadowrocket.yml   每天 03:00 重建规则集
│   └── sync-bettbox.yml        每天 04:00 重建脚本
└── README.md
```

---

## 🔄 数据流（两条独立链）

**链 A — 小火箭**

```
bett-rules 上游
   ↓  sync-shadowrocket.yml（每天 03:00）
scripts/build-shadowrocket.mjs
   ↓  生成
shadowrocket/rules/*.list
   ↓  被 URL 引用
shadowrocket/config.conf  →  手机小火箭
```

**链 B — Bettbox**

```
AIsouler/MyClash 上游
   ↓  sync-bettbox.yml（每天 04:00）
scripts/build-bettbox.mjs  ←── bettbox/rules-extra.txt（手改）
   ↓  生成
bettbox/mihomoScript.js  →  Bettbox 桌面
```

两条链互不相干：改 A 不影响 B。

---

## 📱 小火箭

### 导入

配置 → 右上角 `+` → 填 URL → 下载。之后在配置列表点「更新」。

> ⚠️ 从 URL 更新会**重置所有分组的 UI 选择**回默认值（`policy-select-name`）。

### 规则匹配顺序（45 条）

```
1    广告拦截        ads.list + ADLite
1.5  显式优先        snssdk 直连、muse.ai → AI
2    GitHub → AI     github.list → ai.list → OpenAI → Gemini
3    流媒体          netflix → Disney+ → Max → YouTube → Spotify
4    社交            telegram → meta → tiktok
5    支付            PayPal → Amazon
6    开发云          OneDrive → 微软 → 谷歌 → 苹果
7    游戏            steam → SteamCN → Epic → Nintendo → Sony → Game
8    国内直连        bilibili → douyin → cn-direct
9    兜底            Global(漏网之鱼) → china → private → cn-ip → private-ip
                     → GEOIP,CN → FINAL(漏网之鱼)
```

**每个域名独立从上往下扫，命中第一条即停。**

### 分组默认出口

| 组 | 默认 | 组 | 默认 |
| --- | --- | --- | --- |
| AI | 美国节点 | PayPal / Amazon | DIRECT |
| 谷歌服务 | PROXY | 微软服务 / 苹果服务 | PROXY / DIRECT |
| GitHub | PROXY | 游戏平台 | DIRECT |
| YouTube | 香港节点 | 哔哩哔哩 | DIRECT |
| 其余服务组 | PROXY | 漏网之鱼 | PROXY |
| 地区组（6 个） | 手动，无自动切换 | 广告拦截 | REJECT |

### 规则集清单（21 个）

| 文件 | 来源 | 内容 |
| --- | --- | --- |
| ai.list | geosite/category-ai-!cn | AI 服务 |
| ads.list | geosite/category-ads | 广告 |
| google.list | geosite/google | Google |
| youtube.list | geosite/youtube | YouTube |
| netflix.list | geosite/netflix | Netflix |
| telegram.list | geosite/telegram | Telegram |
| meta.list | geosite/meta | Facebook / Instagram / WhatsApp |
| tiktok.list | geosite/tiktok | TikTok |
| spotify.list | geosite/spotify | Spotify |
| github.list | geosite/github | GitHub |
| microsoft.list | geosite/microsoft | 微软 |
| apple.list | geosite/apple | 苹果 |
| paypal.list | geosite/paypal | PayPal |
| steam.list | geosite/steam | Steam |
| china.list | geosite/geolocation-cn | 中国大陆域名 |
| private.list | geosite/private | 内网域名 |
| douyin.list | geosite/douyin | 抖音 |
| bilibili.list | blackmatrix7 BiliBili | B 站（过滤 USER-AGENT） |
| cn-direct.list | blackmatrix7 ×9 | 网易/百度/微信/抖音/字节/小红书/知乎/微博/豆瓣 |
| cn-ip.list | geoip/cn | 中国大陆 IP 段 |

---

## 💻 Bettbox

在「覆写 / 脚本」设置里填上面的脚本地址。

### 相对上游的补丁

| 补丁 | 内容 |
| --- | --- |
| 规则顺序 | `AdBlock → GitHub → AI → FCM → YouTube → Google → ...` |
| Copilot 归属 | GitHub 在 AI 之前，`copilot*` 自然归 GitHub，无需额外规则 |
| AI 归属 | AI 在 Google 之前，`antigravity` / `gemini` 的 `*.googleapis.com` 不被 Google 抢 |
| 兜底 IP | `cn_ip` / `private_ip` 加 `no-resolve`，省掉每个未命中域名 40~50ms 的无效 DNS |
| 默认开关 | 基础三组 / FCM / Twitter / 地区自动组 / 倍率组关闭，IPv4 优先开启 |

### 加临时规则

编辑 [`bettbox/rules-extra.txt`](bettbox/rules-extra.txt)，一行一条，会被注入 `rules` 最前面：

```
DOMAIN-SUFFIX,example.com,美国
PROCESS-NAME,Antigravity.exe,AI
```

改完推上去 → Action 自动重建 → Bettbox 断开重连生效。

---

## ⏱ 更新节奏

| 变更 | 生效方式 |
| --- | --- |
| 上游规则变化 | 次日 03:00 自动重建 `rules/` |
| 上游脚本变化 | 次日 04:00 自动重建 `mihomoScript.js` |
| 改 `rules-extra.txt` | Action 几分钟内重建（脚本侧自动生效） |
| 改 `shadowrocket/config.conf` | **不自动**，手机要手动点更新 |

---

## 🔧 维护指南

| 想改什么 | 改哪 | 之后 |
| --- | --- | --- |
| 小火箭分流规则/分组 | `shadowrocket/config.conf` | 手机重新导入 |
| Bettbox 临时规则 | `bettbox/rules-extra.txt` | Bettbox 重连 |
| 规则集分类增删 | `scripts/build-shadowrocket.mjs` 的 `GEOSITE` | Action 自动 |
| 换规则上游 | 同上，改 `SRC` | Action 自动 |
| Bettbox 补丁 | `scripts/build-bettbox.mjs` 的 `REPLACES` | Action 自动 |

### 本地生成

```bash
node scripts/build-shadowrocket.mjs          # 全量
node scripts/build-shadowrocket.mjs ai china # 指定分类
node scripts/build-bettbox.mjs               # Bettbox 脚本
node scripts/build-bettbox.mjs --check       # 只校验锚点，不写文件
```

---

## 📐 转换规则

| 源格式 | 输出 | 原因 |
| --- | --- | --- |
| geosite `+.example.com` | `example.com` + `.example.com` 两行 | 小火箭 `DOMAIN-SET` 不认 `+.` 前缀，照搬会静默失效 |
| geosite 裸域名 | 原样保留 | 精确匹配 |
| geoip `1.0.1.0/24` | `IP-CIDR,1.0.1.0/24,no-resolve` | `no-resolve` 写进行内，避免引用漏写导致全量 DNS 解析 |
| blackmatrix7 `USER-AGENT` / `IP-ASN` | 丢弃 | 小火箭规则集不支持，混入会导致整条规则集加载失败 |

---

## 📜 数据来源与许可

规则内容版权归上游 [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules)、
[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)、
[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 所有。

覆写脚本基于 [AIsouler/MyClash](https://github.com/AIsouler/MyClash)。
本仓库仅做格式转换与顺序调整，不主张规则内容的所有权。
