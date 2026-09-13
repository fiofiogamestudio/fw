# 第三方组件

- `sharp`：固定在 package-lock.json，用于本地图片解码和确定性处理。许可证与底层 libvips 组件信息随 npm 包保留。
- 可选 `@esotericsoftware/spine-webgl` 与 `@esotericsoftware/spine-core`：固定为 4.2.120，提供匹配 Spine 4.2 数据的浏览器播放。通过本地 HTTP 原样提供 npm 包的 IIFE 文件，保留版权声明，不从 CDN 加载。

Spine Runtime 使用独立的 [Spine Runtimes License Agreement](https://en.esotericsoftware.com/spine-runtimes-license)，不是 MIT。其原文保存在 [licenses/Spine-Runtimes.txt](licenses/Spine-Runtimes.txt)。使用、集成和分发该可选模块须满足对应 Spine 许可；FWV 本身不提供 Spine Editor 许可证。普通图片流程不依赖该播放器。

示例图标与猫咪素材由本项目代码绘制，未复制第三方游戏素材或官方示例角色。
