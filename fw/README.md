# FW

FW 是组件工作台和工程入口。程序源码集中在本目录，其他组件在外层同级目录；Git 工作台根保留 `.gitmodules` 与 `fw.workspace.json`。

Windows 双击本目录的 `start.bat` 可选择组件。以下命令均在外层工作台根执行（包含 `fw/`、`fwc/` 等目录）。

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| FW | 初始化、组件路径与 Git 版本、环境诊断、启动入口 | 游戏规则、编辑器运行时、Agent 状态 |
| [FWC](https://github.com/fiofiogamestudio/fwc) | Godot 代码框架、C# / GDScript 玩法模板、生成和验证 | 自动安装编辑器或 Agent |
| [FWE](https://github.com/fiofiogamestudio/fwe) | 通用编辑器、配置界面、数据源和扩展运行时 | 开发或美术业务真相 |
| [FWA](https://github.com/fiofiogamestudio/fwa) | 需求拆解、原子变化、验证与验收、采用、撤销和有/无对照 | 内嵌或重复下载 FWE |
| [FWS](https://github.com/fiofiogamestudio/fws) | Agent 技能及显式安装器 | 第二套 Git 同步实现 |
| [FWD](../fwv/README.md)（目录 `fwv/`，开发中） | 素材查看、问题定位、候选修改、评审采用，以及专业美术工具 | 游戏运行时、Agent 编排 |

产品按两层组织：FWC 与 FWE 是相互独立的基础设施；FWA 开发工作台与 FWD 美术工作台使用 FWE 构建界面。FWA 的编排内核仍可单独以 CLI 运行。FW 管入口与版本，FWS 提供可独立使用的技能。

FWV 当前为工作台中的独立开发包，尚未发布为 Git 组件。双击 `fwv/start.bat` 打开本机美术工程；首次缺少示例时才创建 `.local/demo`，再次打开保留已有资产。也可执行 `node fw/bin/fw.mjs visual --project fwv/.local/demo` 后访问输出的网址。现有预设与已发布的四组件版本组合保持原有含义；FWV 发布前不列入 `deps install`。

## 开始

需要 Git、Node.js ≥20.10、PowerShell（Windows 自带或安装 `pwsh`）。Godot 预设的开发工具都需要 FWC 声明的 .NET SDK；`csharp` 游戏需要 Godot .NET，`gdscript` 游戏可使用标准 Godot。目前基线为 SDK 10.0.201、Godot 4.6.2、net8.0，不静默升级工具链。

```powershell
git clone https://github.com/fiofiogamestudio/fw.git
cd fw
$gameProject = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path '../MyGame'))
node fw/bin/fw.mjs new $gameProject --preset godot-agent
node fw/bin/fw.mjs new $gameProject --preset godot-agent --apply
node fw/bin/fw.mjs editor --project $gameProject
```

新建纯 GDScript 游戏可在预演和执行命令中添加 `--runtime gdscript`。省略时，新游戏默认 `csharp`；恢复已有工程时沿用 `fw.toml [runtime].game`，显式冲突会失败，不转换已有玩法。运行时只保存在 FWC 配置中，`fw.workspace.json` 不重复记录。初期 GDScript 路线只支持 `game = ["app"]`、`host = []`；Web 导出仍需独立验收。

不需要先递归拉取工作台的四个组件：`new` 读取外层 FW Git 工作台 **已提交 HEAD** 中的 gitlink，只把选择的组件直接安装到新工程。工作台本身需要维护组件时运行 `node fw/bin/fw.mjs deps sync --apply`。

CLI 可直接用绝对路径调用；愿意注册 `fw` 命令时，进入内层 `fw/` 手动执行 `npm link`。初始化不会注册全局命令、安装全局技能、创建宿主提交或修改旧工程。

新工程结构：

```text
MyGame/
  fw.workspace.json    # 选择和入口，不重复记录版本/路径
  .gitmodules          # 组件来源和路径
  fwc/                 # 直接 gitlink：具体 SHA 由宿主 Git 提交锁定
  fwe/
  fwa/                 # 不含另一个 fwe/
  fw.toml              # FWC 配置，仍由 FWC 独立维护
  .fwa/                # 本机 Agent 状态，初始化时加入忽略规则
  ...                  # FWC 生成的游戏工程
```

成功初始化包括 FWC 模板生成/检查（若选中）和 FWA 本机状态初始化（若选中），不等于游戏已经通过构建与运行验收。审阅并提交宿主文件、`.gitmodules` 和组件 gitlink 后，才形成可复现工程版本。

## 选择组件

| 预设 | 默认组件 |
| --- | --- |
| `godot` | fwc |
| `godot-agent`（默认） | fwc、fwe、fwa |
| `agent-ui` | fwe、fwa |
| `agent` | fwa，无 UI 依赖 |
| `editor` | fwe，需要自己的 `--editor-app tools/editor/app.json` |
| `workbench` | fwc、fwe、fwa、fws，仅组件工作台，不生成游戏模板 |

`--with fws` 可选技能源；也可用逗号选择其他组件。已有 Git 工程用 `fw init --project <root> --preset <preset>` 预演，确认后 `--apply`。不做旧工程兼容迁移，也不覆盖不同的 workspace manifest。

FWE-only 预设不会伪造游戏配置适配器；设置 `editor.app` 指向真正的宿主 app 配置。FWC 生成的配置合同是否可被编辑，仍取决于实际 source/model 适配器。

## 版本管理

```powershell
node fw/bin/fw.mjs deps status --project ../MyGame
node fw/bin/fw.mjs deps sync --project ../MyGame --apply
node fw/bin/fw.mjs deps update fwe --to <commit-or-tag> --project ../MyGame
node fw/bin/fw.mjs deps update fwe --to <commit-or-tag> --project ../MyGame --apply
node fw/bin/fw.mjs deps verify --project ../MyGame
node fw/bin/fw.mjs doctor --project ../MyGame
```

- `sync`：恢复宿主 HEAD 的锁定版本，不跟随 main；有 staged 指针或来源变更时先停，要求审阅。
- `update`：只有显式 `--to` 才选新版本；验证后由用户提交宿主新指针。
- `install`：用于显式修改 `components` 后安装缺失组件。已有组件保留宿主已锁定（无 HEAD 时已暂存）的版本；新组件使用调用方 FW 发布组合的精确 SHA。
- 已有 HEAD 与暂存 gitlink 不一致时，`install` 也会暂停；先审阅并提交版本选择，不让初始化覆盖更新意图。
- `verify`：联网验证 origin 可取回性和宿主已提交指针；没有首提交不能通过。
- `doctor`：只读检查工具、绑定和 HEAD/index/worktree 漂移。对游戏区分 .NET 生成工具和游戏编辑器，通过已构建的 FwGen 查询运行时；若工具未准备，先执行 FWC 的 new/gen/build。它不会构建工具，也不代替远端验收、Godot 构建或运行测试。
- `deps push <组件>`：默认预演，显式 `--apply` 发布已提交的干净组件，不提交本地修改。

批量操作先预检，但不声称跨仓库事务。网络或生成失败可能留下已经创建的目录和组件；错误会给出恢复位置。修复后用同样预设重新 `init`，不靠递归删除恢复。

## 编辑器与技能

`fw editor` 从 `.gitmodules` 解析同级 FWE/FWA 的真实位置，使用固定工程打开 FWA 开发工作台。默认只读；`--allow-write --review-config tools/review.json` 允许界面调用工程明确配置的验证、人工验收、采用、撤销与对照实验流程。检查命令与目标分支来自启动时指定的本地配置，浏览器不能提交任意命令。参见 [FWA 操作说明](../fwa/docs/change-review.md)。

`start.bat fwd` 打开 FWD 美术工作台，默认从素材中心开始；它与原 `start.bat fwv` 使用同一个 `fwv/` 包和项目，保留已有资产与历史。资产修改先成为候选，人工接受并采用后才进入原素材的新版本。

FWA 内核不依赖 FWE；启用它的 UI 才需要兼容 FWE 扩展合同。版本不兼容时明确失败，不回退到第二份编辑器。组件路径重复、重叠、符号链接重路由及嵌套 FW 注册都拒绝。

```powershell
node fw/bin/fw.mjs skills install --project <含fws的工程> --target <技能目标目录>
node fw/bin/fw.mjs skills install --project <含fws的工程> --target <技能目标目录> --apply
```

FWS 的 `fw-sync` 只转发到 `fw/tools/sync.ps1`。独立 FWS 可通过显式 `-FwRoot` 或 `FW_HOME` 指定外层工作台或内层 FW 程序目录；其他技能仍可独立使用。

## 开发和验证

```powershell
npm --prefix fw test
npm --prefix fw run test:sync
```

前者覆盖 manifest、路径/身份、Git 版本事实、路由，以及真实临时仓库的初始化和恢复；后者执行 Git 操作的故障与安全回归。FWE/FWA/FWC/FWS 分别保留自己的测试。工作台提交中的四个 gitlink 是测试组合的唯一版本清单，不另建手工 `versions.json` 或 lockfile。

安装了工作台 FWE/FWA、Node.js ≥22 和 Chrome 后，可运行 `node fw/tools/test-editor.mjs --output .local/reports/editor` 做跨组件浏览器验收。它创建隔离项目和浏览器 profile，覆盖只读导航、真实命令、文本安全以及响应丢失后的幂等重试，输出截图和 JSON 证据；不连接用户的浏览器会话。省略 `--output` 时证据写入系统临时目录。
