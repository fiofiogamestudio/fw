# 上传计划、官方工具与交接

核对日期：2026-09-14。FWB 首版将构建与上传分开。`planUpload` 和 `uploadArtifact` 的默认行为只生成可审查计划；只有显式 `execute: true` 才允许运行上传工具。工具成功上传开发版本，不会自动提审或上线。

本轮实现及测试没有使用真实平台账号上传。发布测试使用本地模拟的进程结果，只验证命令、状态和保护条件；实际账号、平台处理、真机和商店验收仍未完成。

## 已实现的范围

| 目标 | provider | 当前行为 |
| --- | --- | --- |
| 微信小游戏 | `wechat-ci` | 调用官方 miniprogram-ci 的 `upload`，显式指定 `--project-type miniGame` |
| 抖音小游戏 | `douyin-cli` | 调用官方 tmg 的 `upload`，传入版本与版本说明 |
| Poki | `poki-cli` | 调用官方 @poki/cli，保存处理中的远端构建 ID |
| TapTap（App 内即玩） | `handoff` | 仅维护 H5 路线（`taptap-h5`），给出官方后台/MCP 交接步骤；尚无无人值守 OAuth 执行器 |
| Google Play | `handoff` | 指引签名 AAB 与测试轨道交接；当前未实现 Developer API 上传 |
| App Store | `handoff` | 指引 Mac/Xcode 归档、签名和 App Store Connect/TestFlight 交接 |

FWB 当前维护 7 个构建目标，含 Web 基线和上述 6 个发布平台。TapTap 普通小游戏 `taptap-minigame` 已退出维护范围；旧配置须停用或移除该目标，重新配置 `taptap-h5` 后构建 H5 候选包。旧普通小游戏产物只保留历史读取，不再提供校验或上传，也不会自动转换为 H5 包。

TapTap 的交付要求是在手机 TapTap App 内点开并正常游玩。Web 候选包检查或本地浏览器预览通过不代表客户端验收通过；当前尚未完成这项验收。广告、云存档等所需平台 API 仍需按需接入，生成交接计划不会完成这些工作。

Poki 官方已经提供 CLI。初期规划中“尚未确认公开上传工具”的不确定项，现已通过 [Poki 官方仓库](https://github.com/poki/poki-cli)核实。Review 仍需在平台另行申请。

未配置 upload 时，计划默认提供人工交接步骤；也可以显式配置 `"upload": { "provider": "handoff" }`。明确配置 CLI provider 后，缺少工具、凭据或验收证据才会阻断该工具执行。即使为 handoff 传入 `execute: true`，也不会运行平台工具。

## 官方包与配置

上传工具必须已安装。FWB 不运行 `npm install`，不使用动态 `npx` 下载，不接受任意命令或上传 hook。当前实现只接受本轮已核对的以下版本和固定入口：

| provider | npm 包 | 已核对版本 | 固定入口 |
| --- | --- | --- | --- |
| `wechat-ci` | `miniprogram-ci` | `2.1.31` | `bin/miniprogram-ci.js` |
| `douyin-cli` | `tt-minigame-ide-cli` | `2.1.1` | `bin/tmg.js` |
| `poki-cli` | `@poki/cli` | `0.1.19` | `bin/index.js` |

FWB 核对已安装包的名称、版本、bin 声明和入口存在性，并在记录中保存入口文件 SHA-256。包及其依赖应由维护者从官方来源安装和锁定；包元数据检查不等于整个依赖树的供应链认证。升级工具版本前须重新核对命令和回执规则。

在 `fwb.project.json` 对应 `targets.<id>.upload` 下配置。微信示例：

```json
{
  "provider": "wechat-ci",
  "packagePath": "D:/Tools/fwb-platforms/node_modules/miniprogram-ci",
  "toolVersion": "2.1.31",
  "applicationId": "wx1234567890abcdef",
  "privateKeyPathEnv": "FWB_WECHAT_PRIVATE_KEY_PATH",
  "robot": 1,
  "notes": "测试版本 1.2.3",
  "timeoutSeconds": 600
}
```

`privateKeyPathEnv` 保存的是环境变量名称。该环境变量的值是上传私钥文件路径，私钥内容由官方工具读取。FWB 不输出路径环境变量的值，不读取私钥内容；还需按微信平台要求准备上传权限和 IP 白名单。[微信官方包说明](https://www.npmjs.com/package/miniprogram-ci)

抖音使用 `provider: "douyin-cli"`、对应 packagePath/toolVersion 和 `tt...` 应用 ID。用户先完成 `tmg login`；FWB 只检查默认 `~/.tmg-cli/.cookies` 会话文件是否存在，不读取其中 Cookie。当前不支持自定义 CLI 会话存储位置。命令仅上传开发版本，不传未经验证的测试 channel 名称。[抖音官方 CLI 文档](https://partner.open-douyin.com/docs/resource/zh-CN/mini-game/develop/dev-tools/development-assistance/ide-cli)

Poki 使用 `provider: "poki-cli"`、对应 packagePath/toolVersion 和 UUID 格式的 `applicationId`。用户先完成官方 CLI 登录；预检只检查官方默认 `auth.json` 文件的存在性。工具执行时会在上传工作目录写入独立的 `poki.json`，其中 `game_id` 指向配置的游戏，`build_dir` 指向当前产物的隔离副本。[Poki 官方配置说明](https://github.com/poki/poki-cli)

会话文件存在不代表会话仍然有效。过期会话由官方工具拒绝或要求重新认证；FWB 不代填账号或密码。所有 provider 的工具上传 channel 在首版统一限定为 `development`，只表达上传开发版本。`handoff` 使用同名 channel，工作台传来的 development 选择会规范化为 handoff，始终不可执行。审核、生产发布或平台专属测试通道均不会被这个字段隐式触发。

## 上传前必须绑定验收证据

计划先重新执行 `validateArtifact`，检查文件哈希、完整输出集合和平台包结构；这一步会刷新产物的 package 验证结果。Web 包体检查和小游戏 `game.js`/`game.json` 存在性不能代替真实运行验收。

实际执行需要绑定当前产物的运行与平台验收。在「验收与上传」页或 CLI 登记两类报告后，上传检查会核对每类最新记录、产物哈希和报告文件哈希；最新失败会阻断上传。旧工程也可以继续配置 `upload.acceptance`，但当前产物已有报告时以报告为准：

```json
{
  "artifactId": "build_...",
  "outputsSha256": "从本次 upload-plan 取得的 64 位哈希",
  "runtime": "passed",
  "platform": "passed",
  "evidence": "docs/acceptance/wechat-build-001.md"
}
```

`artifactId` 和 `outputsSha256` 必须精确匹配当前产物；证据文件必须真实存在且非空。FWB 保存证据文件的哈希，并明确标记来源为 `operator-attestation`。这是维护者对运行和平台验收的人工声明，不是 FWB 自动完成了设备测试。证据应写明设备、版本、测试项目、结果和平台验收范围。

微信和抖音还核对产物内部 `project.config.json` 的 appid/ttappid、`compileType: "game"` 和根目录。FWB 不在上传阶段改写已验收包的应用身份。修改 appid、重新构建或更换产物后，需要新的验收绑定。

## 执行与状态

执行器持有工程级上传锁，并把清单中的输出复制到：

```text
.local/fwb/releases/<upload-id>/
  release.json
  package/        当前产物的隔离副本
  poki.json       仅 Poki
```

复制后再次核对文件哈希，再运行固定官方命令。原构建产物保持可追溯，官方工具的临时文件不会进入原产物目录。进程使用当前 Node.js、`shell:false`、隐藏窗口、忽略交互输入、有限时间及 256 KiB 输出上限。

计划中的命令是数组，不能拼接为 shell 字符串执行。微信私钥参数只显示 `<env:变量名>` 占位符。实际进程的输出不写入报告或日志；FWB 仅保留退出码、结果原因、输出哈希以及白名单解析出的回执。

| 本地上传状态 | 含义 | 后续处理 |
| --- | --- | --- |
| `uploading` | 已开始一次上传尝试 | 等待；进程中断后先对账 |
| `uploaded` | 官方工具回报上传成功 | 在平台核对处理结果、版本及远端 ID；不代表上线 |
| `failed` | 可证明工具未启动，如 ENOENT/EACCES | 修复本地环境后可重试 |
| `unknown` | 超时、输出超限、非零退出或没有明确成功回执 | 先核对远端；禁止盲目重试 |
| `not-uploaded` | 维护者有证据确认远端未上传 | 可重新规划一次上传 |

成功规则来自本轮核对的官方实现：微信上传 Promise 完成后输出 `done` 并退出 0；抖音需要 `Upload success` 标记；Poki 需要成功标记和匹配游戏 ID 的 Preview 构建链接。**抖音和 Poki 的部分失败路径也可能退出 0，因此只检查进程退出码会误报。** Poki 回执还会保存链接中的远端构建 UUID；其他平台需在后台补充远端版本标识。

同一目标应用、channel 和输出哈希存在 `uploading`、`unknown` 或 `uploaded` 记录时，预检拒绝重复上传。损坏的历史记录也会阻断，避免失去原上传尝试后误发重复包。未决的进程锁需要先核对对应进程，不能直接绕过。

## API

```js
import {
  planUpload, uploadArtifact, listReleases, readRelease, recordUploadReceipt
} from './src/core/publish.mjs';

const plan = await planUpload(root, artifactId, { channel: 'development' });
// { ok, canExecute, status, artifactId, target, provider, applicationId,
//   outputsSha256, checks, command?, handoff, sources, acceptance }

const samePlan = await uploadArtifact(root, artifactId); // execute 默认 false

// 仅在用户明确选择执行上传后调用：
const attempt = await uploadArtifact(root, artifactId, {
  channel: 'development', execute: true
});
```

CLI 可以把 `--execute` 映射到执行参数。当前网页工作台仅展示计划，不开放直接上传。

人工对账示例：

```js
recordUploadReceipt(root, uploadId, {
  status: 'uploaded',
  remoteId: '在平台核对的真实版本或构建 ID',
  evidence: 'docs/acceptance/platform-receipt.md'
});
```

若平台证据确认未上传，可使用 `status: "not-uploaded"`，无需 remoteId。此函数只记录人工对账声明，并不查询远端服务；上传锁未处理时也拒绝改写回执。记录不更新原 artifact 中的运行验收，也不伪造审核或发布状态。
