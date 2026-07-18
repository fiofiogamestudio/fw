# fw

`fw/` 是一套放到 Godot 工程根目录即可接入的框架层。

它提供三类能力：
- Godot 运行时骨架：`AppRoot -> BaseMode -> SystemManager`
- Godot UI / View 子框架：`FUI`、`FForm`、`FWidget`、`FViewRoot`、`FViewStore`、`FRefs`、`FProps`、`FBinding`、`FViewModel`
- C# 工具链：`fw/tools/new.*`、`gen.*`、`build.*`、`test.*`

框架维护文档在：
- `fw/docs/rule.md`
- `fw/docs/spec.md`
- `fw/docs/use.md`

## 接入前提
- Godot 4.6.2 .NET
- .NET SDK 10.0.201（由 `global.json` 固定）
- 已有 Godot 工程，或允许模板创建最小 `project.godot`
- `fw/` 位于工程根目录
- 游戏核心逻辑使用 Godot C# 项目承载

目录形态：

```text
<game_root>/
  fw/
  project.godot
  <game>.csproj
```

## 快速开始
初始化最小工程骨架：

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\fw\tools\new.ps1 -ProjectRoot . -Name MyGame
```

或：

```bash
bash ./fw/tools/new.sh --project-root . --name MyGame
```

生成和构建：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
.\fw\tools\build.ps1
```

如果使用 `just`：

```powershell
just build
```

完整验证：

```powershell
.\fw\tools\test.ps1
```

`new` 会在返回成功前完成生成、配置检查和框架检查。测试会在临时目录创建全新工程，并验证生成、篡改检测、配置打包、Release/Debug 构建、Godot 运行时和主场景启动。

宿主通过 submodule commit 锁定实际框架版本；升级时选择明确的 SemVer tag 或 commit，并把更新后的 `fw` 指针与重新生成的 `_gen` 产物放在同一宿主提交中。

## Hook
框架维护者需要时显式启用：

```powershell
git -C fw config core.hooksPath hooks
```

hook 只把 `fw/docs` 和 `fw/.codex/skills/fw` 同步到默认模板；产生差异时会中止提交等待审阅，不会读取宿主工程或自动暂存。

## 边界
`fw/` 只承载可复用框架能力，不放当前游戏玩法。

属于 `fw/`：
- Godot 通用运行时
- Godot UI / View 子框架
- 框架生成器、工具脚本、模板

不属于 `fw/`：
- 当前游戏的 `scripts/app`
- 当前游戏的 `scripts/mode`
- 当前游戏的 `schema/*`
- 当前游戏的 `csharp/core`
- 当前游戏的 `csharp/bridge`
