# FW 组件工作台

双击 **`start.bat`** 选择组件，也可以进入任意组件目录双击它的 `start.bat`。

| 目录 | 内容 | 双击入口 |
| --- | --- | --- |
| [fw/](fw/README.md) | FW 管理程序、CLI、同步工具和测试 | 组件选择菜单 |
| [fwc/](fwc/README.md) | Godot 游戏框架（C# / GDScript） | 源码目录；可指定宿主游戏 |
| [fwe/](fwe/README.md) | 通用文件编辑器 | 本机示例编辑器 |
| [fwa/](fwa/README.md) | AI 开发工作台：变化、验收、采用、撤销与对照 | 本机演示工程 |
| [fws/](fws/README.md) | Agent 技能库与安装器 | 技能目录与使用说明 |
| [fwv/](fwv/README.md) | FWV 美术工作台：素材、问题、候选与验收 | 本机资产工程 |
| [fwb/](fwb/README.md) | FWB 构建工作台：平台预检、隔离构建、日志和产物 | 本机 Godot 演示工程 |

FWC、FWS 是库，入口不会自动生成游戏或安装全局技能。FWE、FWA、FWV、FWB 首次启动准备各自的 `.local/demo/`，后续启动保留已有数据；FWV 已有的资产工程继续使用。浏览器服务就绪后自动打开页面，关闭启动窗口或按 Ctrl+C 可停止服务。

FWC 是游戏基础设施，FWE 是工具基础设施，二者相互独立。FWA 和 FWV 的界面复用 FWE，各自业务内核仍通过 CLI/API 独立使用；FW 负责组件装配与启动，FWS 提供 Agent 操作技能。FWE 编辑草稿的撤销、FWA 已采用变化的撤销、FWV 资产版本选择分别由对应层负责。

美术产品、目录、包和 CLI 统一使用 **FWV / `fwv`**。使用 `start.bat fwv` 打开已有工程；资产清单和存储格式保持不变。

```powershell
# 在这个工作台根目录运行
start.bat fwv
start.bat fwa --project D:\Games\MyGame
start.bat fwb
node fw/bin/fw.mjs build --project fwb/.local/demo
start.bat --check
node fw/bin/fw.mjs doctor --project .
npm --prefix fw test
```

各组件的 `start.bat --check` 只检查启动条件，不创建工程、不打开窗口。命令行参数详见各组件 README。

## 目录归属

FW 自己的 `bin/`、`src/`、`test/`、`tools/` 和 `package.json` 都位于 `fw/`。外层只保留组件目录、启动导航和工作台登记文件：`.gitmodules` 与 `fw.workspace.json` 描述同级组件；`.github/` 是 GitHub 要求位于仓库根的 CI 配置。

报告、截图和本机演示内容统一放在所属目录的 `.local/`。跨组件历史报告位于 `.local/reports/`；组件报告位于对应组件的 `.local/reports/`。历史报告已保留迁移；报告内部记录的旧绝对路径属于当时执行记录。`.local/` 不参与 Git 提交，自动测试临时工程继续使用系统临时目录。

FWV 的 `fwv/` 与 FWB 的 `fwb/` 源码随本工作台维护，目前尚未登记为独立 Git 子模块。其他四个组件分别在各自仓库提交，由顶层工作台的 gitlink 固定所采用的版本。
