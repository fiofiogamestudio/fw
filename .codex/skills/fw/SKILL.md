---
name: fw
description: 按 fw 规范维护 Godot + C# 游戏工程。
---

# Fw

## 输入
- 维护宿主游戏时先读 `docs/fw/rule.md` 和 `docs/fw/spec.md`。
- 维护 `fw/` 框架自身时读 `fw/docs/rule.md` 和 `fw/docs/spec.md`。
- 需要说明操作方式时读对应目录的 `use.md`。
- 处理 Godot 表现层、C# core、bridge、config、system 注册和生成链。

## 流程
1. 先判断改动属于规则、结构、操作还是具体实现。
2. 长期原则只维护当前目标的 `rule.md`，除非用户明确要求，否则不要擅自改规则。
3. 当前结构和原理变化同步当前目标的 `spec.md`。
4. 操作流程和命令变化同步当前目标的 `use.md`。
5. 宿主文档不得反向覆盖 `fw/docs`；框架模板只从 `fw` 自己的规范源派生。
6. 修改 schema 后运行对应生成命令。
7. 完成后运行 `fw/tools/test.ps1` 或 `fw/tools/test.sh`。

## 输出
- 符合 fw 分层与命名规则的代码、配置和文档。
- 对应生成、构建和测试结果。
