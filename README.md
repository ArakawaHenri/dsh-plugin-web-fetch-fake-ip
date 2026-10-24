# DSH Plus · Fake-IP 抓取

让 web_fetch 在 Clash / mihomo / sing-box 等 TUN fake-IP 环境下正常工作。

这是 [DSH Plus](https://github.com/ArakawaHenri/dsh-plus) 系列的独立组件，包名为 `dsh-plus-web-fetch-fake-ip`。

## 安装

在 DSH 插件管理器中安装本仓库：

```text
https://github.com/ArakawaHenri/dsh-plus-web-fetch-fake-ip
```

也可以安装总包 `https://github.com/ArakawaHenri/dsh-plus`，一次启用全系列。
安装后按 DSH 的提示重启或刷新页面。

## 功能

TUN fake-IP DNS 常把域名解析到 `198.18.0.0/15`。这个保留网段会被 DSH 的原生公网校验拦截，
产生 `WEB_BLOCKED_URL`。本插件继承原生 `HttpFetchProvider`，停用默认实现并接管 `http` provider。

每个目标域名只进行一次 DNS 查询。默认 `fake-ip` 模式额外放行配置的 CIDR，
其余答案继续交给原生校验器，NAT64 探测保持原样。
回环、局域网和其他未放行的保留地址仍受原生校验约束。

`off` 模式允许访问回环和内网地址，适用于明确需要抓取本地服务的场景。
IP 字面量和域名解析结果均可使用。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `fake-ip` | `fake-ip` 额外放行 CIDR；`off` 跳过非公网地址拦截 |
| `allowCidrs` | `['198.18.0.0/15']` | 额外放行的 IPv4/IPv6 CIDR |
| `maxResponseBytes` | `5000000` | 单次响应最大字节数 |
| `maxBodyChars` | `100000` | 返回内容最大字符数 |
| `timeoutMs` | `30000` | 请求超时，毫秒 |
| `maxRedirects` | `5` | 同源重定向最大次数 |
| `userAgent` | 原生默认 UA | 请求 User-Agent |

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-plus-web-fetch-fake-ip
  config:
    mode: fake-ip
    allowCidrs:
      - 198.18.0.0/15
      - fc00::/18
```

## 兼容性

需要 Node.js `>=20`，依赖 DSH 的 `dsh-web` 和 `dsh-web-fetch-http`，
当前声明范围为 `>=0.2.0-rc.1 <0.3.0`。地址解析器需要保留原生 lookup 注入接口。

## 开发

```sh
npm ci
npm run check
npm test
```

直接编辑 JavaScript 源码，无需构建。

本地开发可通过插件管理器安装 `link:/absolute/path/to/dsh-plus/plugins/web-fetch-fake-ip`。

## 许可

MIT。插件图标使用 DSH Plus 系列的 36 × 36 透明 SVG，参考 DSH 原生插件的蓝绿配色。
