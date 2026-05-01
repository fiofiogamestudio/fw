# fw

`fw/` 是一套放到 Godot 工程根目录即可接入的框架层。

它提供三类能力：
- Godot 运行时骨架：`AppRoot -> BaseMode -> SystemManager`
- Godot UI / View 子框架：`FUI`、`FForm`、`FWidget`、`FView`、`FRefs`、`FProps`、`FBinding`、`FViewModel`
- C# 工具链：`fw new`、`fw gen`、`fw build`

框架维护文档在：
- `fw/docs/rule.md`
- `fw/docs/spec.md`
- `fw/docs/use.md`

## 接入前提
- 已有 Godot 工程和 `project.godot`
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
./fw/tools/new.sh --project-root . --name MyGame
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
