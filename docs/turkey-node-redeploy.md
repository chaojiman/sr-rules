# 土耳其落地节点：退订前留档 / 重新开通时一键复原

本文件只记录**部署方法**，不含任何节点凭据（UUID、REALITY 密钥、IP）。
真实凭据存在本地 `local-nodes.yaml`，**不要提交到仓库**。

---

## 一、下次重新买机器后要复原什么

| 资产 | 是否随机器丢失 | 能否复用 |
|---|---|---|
| 内部端口（默认 8443） | 丢 | 复用同一值，客户端不变 |
| 面板外部转发端口（如 1234） | 丢 | **可能变**——重开实例要重新看面板 |
| 公网 IP | 丢 | 必然变 |
| UUID | 不丢（记在本地） | 复用 → 客户端只需改 IP/端口 |
| REALITY 密钥对（public/private key） | 不丢（记在本地 + 服务端备份） | 复用 → 客户端 pbk 不变 |
| SNI（www.microsoft.com） | 不丢 | 复用 |

**结论：退订前把「UUID + REALITY 密钥对 + SNI + 内部端口」留档，重新开通后 5 条命令复原，客户端只改 `server` 和 `port` 两个字段。**

---

## 二、退订前留档（10 秒）

在旧机器上执行，把输出存到本地（不要进仓库）：

```bash
# 节点参数（含 UUID / 公钥）
sb url reality
# REALITY 私钥（重建时要写回去）
grep -o '"private_key": "[^"]*"' /etc/sing-box/conf/VLESS-REALITY-*.json
```

另外在面板里记下：`外部端口 → 内网 8443` 这条映射。

---

## 三、重新开通后一键复原

新实例要求：Debian 12/13 或 Ubuntu 22+、有 systemd、能用 root 登录。

```bash
# 1) 装 233boy 脚本（会自动建一条 Hysteria2，可删）
bash <(wget -qO- -o- https://github.com/233boy/sing-box/raw/main/install.sh)

# 2) 建 REALITY，指定端口与 SNI（不要用 auto，脚本会写成字面量 "auto"）
sb add reality 8443 auto www.microsoft.com

# 3) 复用旧凭据（可选，但客户端就不用改 pbk/uuid 了）
sb id  reality <旧UUID>
sb key reality <旧私钥>
sb restart

# 4) 删掉自动创建的 Hysteria2（NAT 机通常没有 UDP 转发）
sb del Hysteria2

# 5) 取节点链接
sb url reality
```

然后在面板新增映射：`内网 8443 / TCP → 外部新端口`，把链接里的 `:8443` 改成新外部端口。

---

## 四、常见坑（都是踩过的）

- `sb add reality <port> auto auto` 会把 SNI 写成字面量 `auto` → 必须显式给 SNI。
- NAT 小鸡实测**不是**端口白名单，所有监听端口公网可达；但面板映射仍然要做，客户端按映射口连。
- 128MB 套餐必须加 Go 内存限制，否则高并发会换页卡死：
  ```bash
  mkdir -p /etc/systemd/system/sing-box.service.d
  printf '[Service]\nEnvironment=GOMEMLIMIT=56MiB\nEnvironment=GOGC=50\n' \
    > /etc/systemd/system/sing-box.service.d/override.conf
  systemctl daemon-reload && systemctl restart sing-box
  ```
- 日志级别调到 `warn`，减少写盘：
  `jq '.log.level="warn"' /etc/sing-box/config.json > /tmp/c && mv /tmp/c /etc/sing-box/config.json`
- 服务端要能访问 SNI 目标（443）与 GitHub，否则 SNI 校验/脚本下载失败。

---

## 五、客户端侧改动（复用旧凭据时）

Bettbox 里那条 `落地-…` 节点只需改两个字段：

```yaml
server: <新公网IP>
port: <新外部端口>
```

UUID、`public-key`、`short-id`、`servername` 全部不变。
用链式时 `链式中转` 的机场节点也不用动。