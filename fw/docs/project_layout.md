# Project Layout

本规范用于单游戏 Godot 宿主。仓库根、Godot 根与 FWC 工程根是同一个真实目录；`src/` 不是第二个工程根。它不要求把 FW 组件工作台自身改造成游戏目录。

FW 负责组件装配；FWC 负责游戏布局、生成和检查。具体代码角色与运行时规则以 [FWC rule](../../fwc/docs/rule.md)、[FWC spec](../../fwc/docs/spec.md) 和所采用版本为准。不要在宿主复制第二套框架规则。

## Daily view

```text
project/
├─ src/                 code, schema, editable config, host tools, tests
├─ assets/              scenes, prefabs, adopted resources, packed config
├─ docs/                development, requirements and design
├─ output/              delivered reports, previews and packages
├─ fw/                  ordinary directory, not another repository
│  ├─ fwc/              selected independent component
│  ├─ fwe/              optional independent component
│  ├─ fwa/              optional independent component
│  └─ fws/              optional independent component
├─ start.bat
├─ justfile
├─ project.godot
├─ fw.toml
├─ fw.workspace.json
├─ global.json
├─ Directory.Build.props
├─ <Game>.csproj         C# games
└─ <Game>.sln            matching Godot C# solution
```

只建立所选组件的目录。`start.bat` 是唯一便捷启动器，使用英文菜单并转发宿主命令；不再提供功能重复的 `start.cmd` 或中文名称启动器。CLI 与终端仍可直接使用相同命令。FWC 的通用入口只提供它能负责的功能，FWE/FWA/FWV 菜单项由实际接入的宿主配置，不伪造未配置的编辑器。

组件独立属于宿主，不把 FWE 安装进 FWA 或 FWC 仓库。新登记默认使用 `fw/<component-id>`；`.gitmodules` 已登记的旧位置继续生效，`init/install/sync` 不自动迁移它们。旧宿主如果已把整个 `fw/` 注册为 FWC，不能在其中增加 `fw/fwe`：先明确选择不重叠的组件位置并登记，或执行单独审阅的目录迁移。

新游戏的具体文件由选中 FWC 的固定版本模板提供。更新 FW 程序的默认安装位置，不等于宿主已经采用尚未发布的新 FWC 模板或布局能力。

## One authority per fact

| Fact | Authority | Contract |
| --- | --- | --- |
| 游戏路径、schema、源与生成物 | `fw.toml`，由 FwGen 解析 | 使用所采用 FWC 版本支持的字段；新版本的 `layout` 路径供模板、生成和检查共同使用 |
| 组件来源与安装位置 | `.gitmodules` | 组件 ID 不等于目录名；不得另建手写绝对路径表 |
| 组件精确版本 | 宿主提交中的 gitlink | HEAD、index、组件实际 HEAD 与远端状态分别核对 |
| 组件选择与默认编辑器 | `fw.workspace.json` | 不重复记录版本或游戏布局；FWV 不伪装成受管组件 |
| .NET 与 Godot SDK、程序集 | 根 `global.json`、`Directory.Build.props`、工程声明 | 按 FWC 校验一致性；不因整理目录升级工具链 |
| 资源目标与已采用版本 | 宿主 FWV 路由定义及交付锁 | 相对路径、确切 revision 与哈希；不能使用 selected/latest 代替采用记录 |

生成器提供的路径解析结果供宿主使用；不要让菜单、FWE adapter、FWA profile 各自解析或猜测一套布局。必须投影到其他工具格式时，生成并检查一致性；历史证据里的旧路径保持原记录。

根文件是工具入口，不是目录噪声：`fw.toml`、`global.json`、`Directory.Build.props` 是当前 FWC 检查要求的固定根文件。`fw.workspace.json` 是顶层 `fw doctor/deps/editor` 的入口，直接使用 Godot 或 FWC 并不自动要求它。`project.godot` 和程序集声明保留真实工程身份。C# 宿主保留根 `<Game>.csproj` 及同名 `<Game>.sln`（例如 `MeowTeam.csproj` 与 `MeowTeam.sln`），解决方案包含该游戏工程；这是 Godot 工具入口，不能为整理根目录而删除或搬走。实际 Godot 4.7.2 .NET 导出已验证缺少该解决方案会导致 C# 导出失败。

## Source and runtime data

- `src/csharp` 保留 Core 与 bridge 边界，`src/scripts` 保存 Godot 表现；游戏编译显式选择这些源，不把 tests、tools 或组件源码递归编进主程序集。
- `src/schema` 定义合同，`src/config` 是 FWE 编辑的配置源。FWC `_gen` 与 `_fw` 是派生物，禁止手改；FWE app/adapter 和派生界面分开。
- `assets/scenes` 保留 app/env，`assets/prefabs` 保留 actor/form/widget/fx。移动后必须由实际 FWC 路径检查覆盖，不能以旧目录不存在导致的跳过作为通过。
- `assets/config` 存运行配置包，开发与发布都要确认包对应当前源。FWE 保存只表示源已保存；配置内容、schema、packer 与包哈希一致后才表示已应用。
- 运行资源留在 assets。2D 原件与不可变版本保存在 FWV 持久库，编辑后通过宿主路由验证并交付。旧项目已有的来源和交付历史保留为证据。不要再维护平行的业务 art 目录，也不能删除不可重建的原件。

## Command lifecycle

这些是宿主入口的职责合同；具体命令由实际模板/宿主实现，FW 不把未接入的动作伪装成成功。

| Command | Responsibility |
| --- | --- |
| `prepare` | 检查固定依赖，准备独立 FwGen，生成合同、投影与 FWE 派生物；不升级组件 |
| `pack` | 校验配置源，生成运行配置包和新鲜度凭据 |
| `build` | `prepare → pack → compile`，游戏编译不反调完整 build |
| `check` | 检验当前路径、生成物、配置包与资源锁；陈旧时失败，不自动修复 |
| `verify` | 先 check，再在受控环境编译和测试；不先生成来掩盖陈旧输入 |
| `package` | 构建、验证、导出并验证实际包；上传与发布是独立操作 |
| `clean` | 只清当前 checkout 的 `.local/`；活动任务占用时拒绝 |

先完成无需 FwGen 的基础环境检查，再准备生成器，最后执行需要已构建生成器的诊断。`fw doctor` 不构建、不修复工程；游戏预设缺根 `fw.toml` 必须失败，不能静默跳过游戏检查。组件 `deps sync` 与 FWC kit `sync` 是不同动作。

菜单默认打开本工程 Godot；其他编辑器使用显式项目和真实 app。FWA 打开控制台不自动启动 Run；FWV/FWA 不省略项目参数而误入组件 demo。服务核对工程身份和端口归属，不复用其他工程的服务。

## FWA worktrees and persistent state

普通游戏任务保护整个 `fw/`，仅授权必要宿主范围。验证入口和冻结输入另有明确权限，不能随业务修改自行放宽验收。每个 Run/Evaluation 都验证实际组件文件及固定版本，不假设 Git worktree 自动初始化子模块。

Run 捕获拒绝 ignored-untracked；把缓存移到 output 或加 Git ignore 不能解决捕获问题。依赖准备和生成需证明不会污染 ChangeSet。构建、探针与截图在受控 Evaluation 中产生，通过声明的 expectedArtifacts 采集后才能清理；真实 Run、ChangeSet、Evaluation、Evidence 与采用状态分开报告。

| Location | Retention |
| --- | --- |
| `output/` | 已交付成果，禁止覆盖，不属于 clean |
| `.local/` | 可重建本机临时输出，活动任务结束后清理 |
| `.fwa/` | 持久任务、审查与证据；备份恢复，不当缓存 |
| `.fwv/` | 持久原件、版本、导出与已有交付历史；备份恢复 |
| `.godot/`、bin/obj | 引擎和工具链默认缓存，不由通用 clean 顺带删除 |
| `user://` | 玩家存档；自动化使用独立存档位置，不覆盖玩家数据 |

Git ignore 不等于可删除。持久库和交付结果要有实际备份与恢复验证。干净克隆可从固定依赖、版本化源和已交付资源恢复游戏，不依赖重新调用生成模型。

## FWV remains an explicit external binding

本 FW 仓库的 `fwv/` 是顶层仓库维护的开发包，不是独立 Git 子模块；产品、目录、包和 CLI 统一为 FWV / `fwv`。当前受管 ID 只有 fwc/fwe/fwa/fws，不为 FWV 虚构独立版本或自动创建 `fw/fwv`。已有宿主持久库由 `--project` 指定，保留实际路径和历史数据，不在命名升级时自动搬迁。`fwv/ui/` 是固定 UI 截图审阅程序；截图和审阅记录仍属于游戏产物目录。

用显式 `--fwv-path` 和 `--fwe-path` 选择实际组件，用 `--project` 指向宿主持久资产库。`fw visual` 校验包身份；它不登记新组件、不发布 Git 版本。FWV 导出确切 revision 包，宿主路由校验后同步到 assets；这不是任意路径的 HTTP 代理，也不能用 junction 绕过存储边界。

未来正式纳入 FW 组件管理前，需完成真实仓库/版本发布、产品与包身份映射、catalog、deps/doctor/恢复和版本回归。仅增加一个枚举不算完成接入。

## Acceptance

必须验证新布局错误会被拒绝、配置修改后旧包被拒绝、生成重复执行稳定、干净依赖恢复、真实游戏启动及导出、FWA 捕获和证据归档、FWV 确切版本导出与宿主发布、持久库恢复。版本检查、构建成功与视觉/交互验收分别报告；目录统一不意味着 C# Godot 游戏获得 Web 导出支持。

导出验收同时核对进程退出码、完整错误日志和实际导出程序的启动结果。Godot 4.7.2 .NET 在 C# 导出报错时仍可能返回 0 并留下不可运行的 exe，因此文件存在或退出码为 0 均不足以判定成功；运行探针须使用独立存档并保留日志。
