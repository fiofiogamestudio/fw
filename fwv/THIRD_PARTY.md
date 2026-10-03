# 第三方组件

- `sharp`：版本固定在 `package-lock.json`，用于 PNG/JPEG/WebP 解码、完整性检查和独立示例图片生成。许可证及底层 libvips 信息随 npm 包保留。
- `@napi-rs/canvas`：版本固定的 MIT 开发依赖，用于真实 Canvas 像素回归；不参与编辑器服务运行，许可证随 npm 包保留。
- FWE：从显式指定的本地组件路径加载，提供编辑器外壳和原生界面。

骨骼数据验证与 2D 采样位于本组件源码中。已移除 Three.js、GLTF Validator 和 Spine Runtime 依赖。示例图标与风车由项目代码绘制。
