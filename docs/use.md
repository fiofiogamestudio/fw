# Fw Use

## 看什么

- 看框架怎么给新项目使用：`fw/README.md`
- 看框架维护规则和结构：`fw/docs/*`

## 在当前仓库里怎么维护

框架相关维护说明统一看：

- `fw/docs/rule.md`
- `fw/docs/spec.md`
- `fw/docs/use.md`

不要再在宿主仓库下创建 `docs/fw/`。

## 当前仓库里常用什么

生成：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
```

构建：

```powershell
.\fw\tools\build.ps1
```

如果只想跑完整主链，也可以直接：

```powershell
just build
```

## 改框架时的原则

当前仓库已经固定采用下面这条规则：

- system 只保留 `refs / config / state`
- scene / camera / pool / FUI 这类宿主依赖不进入 system context
- 需要接触场景对象时，优先新增 host，而不是往 system context 里塞对象引用

## 改完后怎么验证

常用顺序：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\build.ps1
godot_console.exe --headless --editor --quit --path .
godot_console.exe --headless --quit-after 1 --path .
```

如果这次还改了模板，额外补一轮：

```powershell
.\fw\tools\new.ps1 -ProjectRoot <temp_project> -Name Smoke
```

## 提交顺序

如果这次改动同时涉及：

- `fw/` 子仓库
- 宿主仓库中的接入代码或文档

顺序固定是：

1. 先在 `fw/` 子仓库里提交
2. 再回到宿主仓库提交 submodule 指针和宿主侧改动
3. 如果要推远端，先推 `fw/`，再推宿主仓库

## 改文档时怎么改

- 给外部使用者看的接入说明：改 `fw/README.md`
- 给框架维护者看的规则、结构和操作说明：改 `fw/docs/*`
