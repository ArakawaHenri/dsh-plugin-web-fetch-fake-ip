# dsh-plugin-web-fetch-fake-ip

在 **fake-IP / TUN** 环境（Clash、mihomo、sing-box 等）下，让 DeepSeek Harness 的 `web_fetch` 重新可用。

适用于 DeepSeek Harness `0.2.0-rc.2`（本机实测版本），macOS + TUN `utun` + fake-IP 解析。

---

## 问题

harness 的 `web_fetch` 会先解析域名，再用 `ipaddr.js` 判定每个地址：

```js
if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
```

fake-IP 模式下，TUN 的 DNS 对**任何**域名都返回 `198.18.0.0/15` 里的地址（RFC 2544 基准测试段），而 `ipaddr.js` 把它归类为 `reserved` 而不是 `unicast`，于是整个应答集被拒：

```
WEB_BLOCKED_URL: URL hostname "example.com" resolves to a non-public IP address
```

实测（本机）：

| 域名 | DNS 返回 | `ipaddr.js` range | 原厂判定 |
|---|---|---|---|
| `github.com` | `198.18.1.61` | `reserved` | 拒绝 |
| `example.com` | `198.18.15.172` | `reserved` | 拒绝 |
| `localhost` | `127.0.0.1` | `loopback` | 拒绝 |
| `8.8.8.8` | — | `unicast` | 放行 |

> 顺带说明：源码里确实存在一条绕过地址校验的路径——配了代理（`HTTP_PROXY` 等）时 `proxyRouteFor` 返回 proxied，`requestOnce` 会直接走代理、跳过校验。那是"让代理去解析"，本插件解决的是**不走代理**的直连场景。

## 两种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `fake-ip`（**默认**） | 在原厂校验之外，额外放行 `allowCidrs` 里的地址（默认 `198.18.0.0/15`）；其它非公网地址**保持原样被拒** | 只想让 `web_fetch` 在 fake-IP 下能用，同时保住 SSRF 防护 |
| `off` | 原厂校验拒绝时，直接返回该域名的原始解析结果（**彻底取消**地址检查） | 连 `127.0.0.1`、内网地址也要能 fetch |

两种模式下，原厂校验都是**先跑**的；插件只在它返回 `WEB_BLOCKED_URL` 时重新审视被拒的地址。

## 安装

> 插件在**启动时**参与 profile 组装，装完必须重启 DeepSeek Harness 才生效。
> 另外：`~/.dsh/profiles/desktop/cordis.yml` 是每次启动被覆写的**输出**文件，改它没有任何作用；真正的输入是 `package.json` 的 `dsh.profile.bundles` 和 `cordis.patch.yml`。

### 方式 A：应用内插件页（推荐，最省事）

设置 → 插件（Plugins）→ 填入**绝对路径**后安装：

```bash
cd dsh-plugin-web-fetch-fake-ip && pwd   # 打印出的绝对路径就是要填的内容
```

宿主的 `parseInstallSpec` 接受绝对路径（也接受 `file:` 前缀），安装后会自动把包名追加到 `dsh.profile.bundles`（`selectBundle`），无需手改配置。然后重启应用。

实测差异（`pnpm add` 的行为；下面的 `$PWD` 指仓库目录）：

- 填**裸路径** `"$PWD"` → 装成 `link:` 符号链接，改动即时可见，但这个目录必须一直存在。
- 填 `"file:$PWD"` → 装成副本（硬链接），和本目录解耦。

想长期使用建议用 `file:` 前缀，或者直接用方式 B（复制安装）。

### 方式 B：`install.mjs`（不依赖 pnpm / GUI）

```bash
# 在仓库目录下执行；先完全退出 DeepSeek Harness
node install.mjs --profile desktop
# 再启动应用

# 只想看看会改什么：
node install.mjs --profile desktop --dry-run
# 卸载（恢复原厂 web_fetch 行为）：
node install.mjs --profile desktop --uninstall
```

它把包复制进 `<DSH_HOME>/profiles/desktop/node_modules/`，登记 `file:` 依赖并把包名追加到 `dsh.profile.bundles`，同时把原 `package.json` 备份成 `package.json.bak-<时间戳>`。

### 方式 C：`dsh plugin` CLI

```bash
# 在仓库目录下执行
dsh plugin --profile desktop add "file:$PWD"
```

需要 `dsh` 命令在 PATH 上，且 desktop profile 只允许由**应用自带的 dsh 载体**管理：直接跑 app.asar 里的 `bin.js --profile desktop` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`）。此路径已在隔离 profile 上实测通过（`pnpm` 会自动追加 `dsh.profile.bundles`）。

## 验证

`test/boot/run.sh` 会在一个临时 `$DSH_HOME` 里把**真实 harness** 启动三次（不碰 `~/.dsh`），由探针插件在启动后调用 `ctx.web.fetch()`：

```bash
./test/boot/run.sh          # DSH_APP=/path/to.app 可覆盖
```

本机实测输出（DSH 0.2.0-rc.2，fake-IP TUN 开启）：

```
===== baseline (exit after 3s) =====   # 原厂提供方
[probe] FAIL https://example.com/ -> WEB_BLOCKED_URL: URL hostname "example.com" resolves to a non-public IP address
[probe] FAIL http://127.0.0.1:39099/ -> WEB_BLOCKED_URL: URL hostname "127.0.0.1" resolves to a non-public IP address
===== fakeip (exit after 3s) =====     # mode: fake-ip
[probe] OK   https://example.com/ -> HTTP 200 html :: <!doctype html><html lang=en><head><meta charset=u
[probe] FAIL http://127.0.0.1:39099/ -> WEB_BLOCKED_URL: URL hostname "127.0.0.1" resolves to a non-public IP address
===== off (exit after 3s) =====        # mode: off
[probe] OK   https://example.com/ -> HTTP 200 html :: <!doctype html><html lang=en><head><meta charset=u
[probe] OK   http://127.0.0.1:39099/ -> HTTP 200 html :: <!DOCTYPE HTML> <html lang="en"> <head> <meta char
```

单元测试（不需要应用）：

```bash
node --import ./test/loader.mjs --test test/*.test.js   # 28 passed
```

## 工作原理

`FakeIpHttpFetchProvider` **继承**原厂 `HttpFetchProvider`，只替换它构造函数里那个"解析地址"注入点：

```js
class FakeIpHttpFetchProvider extends HttpFetchProvider {
  constructor(resolved) {
    super(resolved.limits)
    this.id = resolved.providerId            // 默认 'http'：web 行本来就 pin 这个 id
    const validatePublic = this.resolveAddresses   // 原厂校验，原封不动留着
    this.resolveAddresses = createFakeIpResolver({ mode, allowCidrs, validatePublic })
  }
}
```

于是重定向策略、字节/字符上限、超时、内容类型判定、代理路由、连接地址钉扎（`createPinnedLookup`）全部仍是原厂代码：

```
ctx.web.fetch()
  └─ requestOnce()                     —— 原厂：代理路由判断
      └─ this.resolveAddresses()       —— 插件：唯一被替换的一环
          ├─ 1) validatePublic()       —— 原厂校验：公网单播才放行
          └─ 2) 仅当它抛 WEB_BLOCKED_URL 时：
                重新解析域名，逐地址判定
                  ├─ 命中 allowCidrs            → 放行（这就是 fake-IP 的那一条）
                  ├─ 原厂校验对单个地址放行     → 放行（例如混在里面的真实公网 AAAA）
                  ├─ mode: off                  → 整组放行
                  └─ 其它                       → 原样抛出原来的错误
```

这样做的好处：**没有任何一份"私有地址段清单"被重写**。除被显式放行的 CIDR 之外，每个地址的判定仍然由 harness 自己的代码给出，不存在范围表漂移的风险。

`cordis.patch.yml`（本插件的 bundle 层）：

```yaml
- id: web-fetch-http
  disabled: true          # 关掉原厂 http 提供方
- insert:
    - id: web-fetch-fake-ip
      name: dsh-plugin-web-fetch-fake-ip
      config:
        mode: fake-ip
        allowCidrs: [198.18.0.0/15]
```

插入行沿用提供方 id `http`，因此 `web` 行的 `fetchProvider: http`（由 `dsh-base` 层定义）不用改——**patch 层的 `config` 是整体替换而不是深合并**，去改 `web` 行就得把 `searchProvider` 一起重述，反而容易在别的设置被改写时被覆盖。

## 安全边界

- **`fake-ip` 模式**：只多放行 `allowCidrs` 里的地址。回环、RFC 1918、链路本地（`169.254.0.0/16`，含云 metadata `169.254.169.254`）、CGNAT、保留段仍然被原厂校验拒绝；对 IP 字面量（`http://127.0.0.1/`、`http://192.168.1.1/`）同样不放行。
- **`off` 模式**：完全取消地址检查，`web_fetch` 可以摸到 `127.0.0.1` 与本机/内网服务。请注意 harness 的 `bash` 工具本来就能 `curl`（本机 sandbox 策略为 workspace-write，未限制出网），所以这不是新增能力；但 `web_fetch` 的 URL 往往直接来自网页内容或模型判断，暴露面更大。默认不开。
- 代理路由（`proxyRouteFor` → `requestVia`）本来就不做地址校验，插件不改变这条路径。
- 本插件不改变 `searchProvider`、不改 `tool-web`、不改任何别的行。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `fake-ip` | `fake-ip` 或 `off` |
| `allowCidrs` | `['198.18.0.0/15']` | `fake-ip` 模式下额外放行的 CIDR，支持 IPv4/IPv6 |
| `providerId` | `http` | 注册用的提供方 id；保持 `http` 才能沿用 `web` 行的 pin |
| `maxResponseBytes` | `5000000` | 同原厂默认 |
| `maxBodyChars` | `100000` | 同原厂默认 |
| `timeoutMs` | `30000` | 同原厂默认 |
| `maxRedirects` | `5` | 同原厂默认 |
| `userAgent` | 原厂默认 UA | 请求头 |

在**你自己的** patch 层（`~/.dsh/profiles/desktop/cordis.patch.yml`，在 bundle 层之后应用）覆盖时，注意 `config` 是整体替换——要重述所有想保留的键：

```yaml
# 切成彻底取消地址检查
- id: web-fetch-fake-ip
  config:
    mode: off
    allowCidrs:
      - 198.18.0.0/15

# 或者：换用别的 fake-IP 段（例：sing-box 自定义段 / IPv6 fake-ip）
- id: web-fetch-fake-ip
  config:
    mode: fake-ip
    allowCidrs:
      - 10.0.0.0/8
      - fc00::/18
```

未知字段会**报错而不是被忽略**，所以拼错键名会在启动时炸出来，而不是悄悄用默认值。

## 回滚

- `node install.mjs --profile desktop --uninstall`，或在插件页卸载，或删掉 `dsh.profile.bundles` 里的 `dsh-plugin-web-fetch-fake-ip` 并移除 `node_modules/` 下对应目录，然后重启。
- **不要**只把 `web-fetch-http` 的 `disabled` 改回 `false`：那样原厂提供方会和本插件同时注册 id `http`，启动时报 `WEB_DUPLICATE_PROVIDER`。要回原厂行为，就卸载本插件包（它的 bundle 层随之消失，原厂行自然恢复）。

## 排错

- **启动报 `WEB_DUPLICATE_PROVIDER`**：本插件的 bundle 层没生效，但提供了 id `http` 的行——确认包名在 `dsh.profile.bundles` 里且 `node_modules/<包名>` 存在。
- **`web_fetch` 报 `WEB_PROVIDER_CONFIGURED_MISSING`**：包被移走了但 bundle 名单还在（或反之），重跑一次安装/卸载即可。
- **`pnpm` 提示 `Issues with peer dependencies found`**：正常。`@deepseek-ai/dsh-web*` 由应用本身提供，profile 里不装（`autoInstallPeers: false`），这与仓库里其它插件一致。
- **其它 fake-IP 段**：把实际段写进 `allowCidrs`。可以用 `node -e` 自查：

  ```bash
  node -e 'require("dns").lookup("github.com",{all:true},(e,a)=>console.log(a))'
  ```

- **IPv6 fake-IP**：本机 TUN 只返回 A 记录；如果你的 DNS 还返回 `fake-ip-range6`（常见 `fc00::/18`）而 `web_fetch` 仍被拒，把它加进 `allowCidrs`。
- **DSH 升级后**：跑一次 `./test/boot/run.sh`。若 `dsh-base` 不再定义 `web`/`web-fetch-http` 行，本插件的 patch 会给出 warning 并失去作用（此时插件不会生效，但也不会把 `web_fetch` 弄坏）。
- **兼容性门禁**：本插件声明 `@deepseek-ai/dsh-web*: ">=0.2.0-rc.1 <0.3.0"`。宿主只校验 `@deepseek-ai/dsh*` 前缀的 peer 范围，且是与**运行时版本**（0.2.0-rc.2）比较；范围不满足时安装会被拒绝，需要 `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。

## 目录

```
src/index.js              cordis 插件：配置校验 + 提供方子类
src/network.js            地址策略（CIDR 解析/匹配、原始解析、策略解析器）
cordis.patch.yml          bundle 层：停用原厂行 + 挂载本插件
install.mjs               不依赖 pnpm 的安装/卸载脚本
test/*.test.js            单元测试（28 项）
test/boot/                真实 harness 启动验证（探针 + 三组 profile）
```
