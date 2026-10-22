# dsh-plugin-web-fetch-fake-ip

让 DeepSeek Harness 的 `web_fetch` 在 Clash / mihomo / sing-box 等 TUN fake-IP 环境下正常工作。

## 背景

DeepSeek Harness 内置的 `web-fetch-http` 在发起请求前会解析域名，并用 `ipaddr.js` 校验返回的地址是否为公网单播（`unicast`）。

开启 TUN fake-IP 时，本地 DNS 会将域名解析到 `198.18.0.0/15`（RFC 2544 基准测试网段）。`ipaddr.js` 将该网段归类为 `reserved` 而非 `unicast`，导致所有 `web_fetch` 请求报错：

```text
WEB_BLOCKED_URL: URL hostname "example.com" resolves to a non-public IP address
```

本插件继承内置的 `HttpFetchProvider`，通过 `cordis.patch.yml` 停用默认的 `web-fetch-http` 并接管 `http` provider：利用内置校验器可注入 lookup 的扩展点，每次解析只做**一次** DNS 查询——`fake-ip` 模式下将命中 `allowCidrs` 的答案暂时扣下，其余地址交由内置校验原样判定（NAT64 探测不受影响）；内置校验整体放行时返回完整答案集，拒绝时只有全部答案都在放行列表内才放行。其余私有/保留地址（如 `127.0.0.1`、局域网、链路本地与云 metadata 地址）保持原有的拦截行为。

## 安装

在 DeepSeek Harness **设置 → 插件** 中填入本仓库的本地路径（如 `file:/path/to/dsh-plugin-web-fetch-fake-ip`）或包名进行安装，安装后重启应用生效。

也可以通过 CLI 安装：

```bash
dsh plugin --profile desktop add "file:$PWD"
```

## 配置

默认配置位于插件的 `cordis.patch.yml`（配置经由 Schemastery `Config` 校验，插件提供中英文元数据）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `'fake-ip'` | `'fake-ip'`：在默认公网校验之上放行 `allowCidrs`；`'off'`：跳过非公网地址拦截（允许访问 `127.0.0.1` 与内网） |
| `allowCidrs` | `['198.18.0.0/15']` | `fake-ip` 模式下额外放行的 IPv4/IPv6 CIDR 列表（启动时校验格式） |
| `maxResponseBytes` | `5000000` | 单次响应最大字节数 |
| `maxBodyChars` | `100000` | 解码后返回的最大字符数 |
| `timeoutMs` | `30000` | 请求超时时间（毫秒） |
| `maxRedirects` | `5` | 同源重定向最大次数 |
| `userAgent` | 内置默认 UA | 请求 `User-Agent` |

如需自定义（例如自定义 fake-IP 网段、启用 IPv6 fake-IP `fc00::/18`，或切换为 `off` 模式），可在 profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/desktop/cordis.patch.yml`）中覆盖：

```yaml
- id: web-fetch-fake-ip
  config:
    mode: fake-ip
    allowCidrs:
      - 198.18.0.0/15
      - fc00::/18
```

## 测试

```bash
npm test
```

## License

MIT
