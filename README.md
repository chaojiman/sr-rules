# sr-rules

把 [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules) 的 mihomo 规则集，
转换成 [Shadowrocket](https://apps.apple.com/app/shadowrocket/id932747118) 可直接引用的格式。

每天北京时间 03:00 由 GitHub Actions 自动拉取上游并重新生成 `rules/`。

## 用法

在 Shadowrocket 配置里直接引用（DOMAIN-SET 用域名集，RULE-SET 用 IP 集）：

    [Rule]
    # 域名类（geosite）
    DOMAIN-SET,https://raw.githubusercontent.com/chaojiman/sr-rules/main/rules/ai.list,AI
    DOMAIN-SET,https://raw.githubusercontent.com/chaojiman/sr-rules/main/rules/china.list,DIRECT

    # IP 类（geoip，行内已带 no-resolve）
    RULE-SET,https://raw.githubusercontent.com/chaojiman/sr-rules/main/rules/cn-ip.list,DIRECT

大陆网络拉不动 raw.githubusercontent.com 时，把域名换成 jsDelivr：

    https://cdn.jsdelivr.net/gh/chaojiman/sr-rules@main/rules/ai.list

## 文件说明

| 文件 | 来源 geosite/geoip | 内容 |
| --- | --- | --- |
| ai.list | category-ai-!cn | AI 服务 |
| crypto.list | category-cryptocurrency | 交易所 / 加密 |
| ads.list | category-ads | 广告 |
| google.list | google | Google |
| youtube.list | youtube | YouTube |
| netflix.list | netflix | Netflix |
| telegram.list | telegram | Telegram |
| twitter.list | twitter | Twitter / X |
| meta.list | meta | Facebook / Instagram / WhatsApp |
| tiktok.list | tiktok | TikTok |
| spotify.list | spotify | Spotify |
| github.list | github | GitHub |
| microsoft.list | microsoft | 微软 |
| apple.list | apple | 苹果 |
| paypal.list | paypal | PayPal |
| steam.list | steam | Steam |
| china.list | geolocation-cn | 中国大陆 |
| private.list | private | 内网 |
| douyin.list | douyin | 抖音 |
| cn-ip.list | geoip/cn | 中国大陆 IP 段 |
| private-ip.list | geoip/private | 内网 IP 段 |

## 转换规则

- geosite `+.example.com` → `example.com` + `.example.com` 两行（精确 + 后缀），因为 Shadowrocket 的
  `DOMAIN-SET` 不认 `+.` 前缀，直接照搬会静默失效。
- geosite 裸域名 `example.com` → 原样保留（精确匹配）。
- geoip `1.0.1.0/24` → `IP-CIDR,1.0.1.0/24,no-resolve`，IPv6 段 → `IP-CIDR6`。
  `no-resolve` 写进行内，避免引用时漏写导致每个域名都强制解析 DNS。

## 本地生成

    node build-rules.mjs          # 全量
    node build-rules.mjs ai china # 只生成指定分类

## 数据来源与许可

规则内容版权归上游 [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules) 及
[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community) 所有，
本仓库仅做格式转换，不持有规则内容的主张权。
