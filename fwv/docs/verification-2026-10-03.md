# FWD 2D 转型与发布前验证

验证范围为当前 `fwv` 的 2D 图库、区域与加权网格骨骼编辑，以及旧工作流退场后的数据兼容。环境为 Windows x64、Node.js 24.14.1；FWE 显式选择同级工作台，提交为 `f85517a650e12e79c3b0408536ce08122c8d0b28`。

## 本轮修正

- README、架构和验证说明统一为区域附着与加权网格合同；保留对原生 Spine 的显式转换要求和 IK、deform、linked mesh 等未支持边界。
- 图库浏览器验收移除特定游戏工程的 FWE 路径；图库与骨骼验收均默认同级 `../fwe`，支持 `FWV_BROWSER_FWE_PATH` 显式覆盖。
- 固定 `@napi-rs/canvas` 1.0.10 为开发依赖，14 项真实像素回归不再因缺少依赖静默跳过。删除已随旧模块退场、且当前源码无使用者的 `earcut` 依赖。npm 安装审计报告零漏洞。

## 实际结果

- `npm test`：101/101 通过，零失败、零跳过，包含全部 14 项 Canvas 像素回归。日志：`.local/reports/sync-20261003/fwd-release/npm-test.log`。
- `test:gallery2d-browser`：8 项场景通过，浏览器错误和写入请求均为零。覆盖原图归组、状态切换竞争、48 项分页、历史版本、PNG/JPEG/WebP 精确预览、缩放/拖动，以及到骨骼素材的确切导航。报告：`.local/reports/gallery2d-browser/run-QEs5IX/report.json`。
- `test:skeleton2d-browser`：15 项场景、9 项缩略图检查和 4 项画布/DPR 检查通过，浏览器错误为零。覆盖播放、DAG、DPR 1/2、字段约束、关键帧、撤销/重做、草稿重载、修订事务期间禁止切换、不可变修订、导出及网格权重编辑。报告：`.local/reports/skeleton2d-browser/run-JrKHyd/report.json`。
- 两项浏览器测试均以 `FWV_BROWSER_FWE_PATH=D:/Git/fw/fwe` 执行，只使用 `.local/reports/` 内新建的独立美术工程与临时 headless Chrome 配置；没有修改已有美术工程。已查看图库详情及网格编辑截图，确认测试画面与断言对应。
- `git diff --check -- fwv` 通过。旧模块的活动导入引用及特定游戏绝对路径检查无残留；历史字段名仅用于不透明历史数据保留和旧入口拒绝回归。
- `npm pack --dry-run --json` 检查交付清单；`.local`、报告、`node_modules`、日志和常见密钥文件均不进入包。Git 同样忽略测试产物及已安装依赖。

这些结果证明本次框架用例中的技术与交互行为，不替代实际游戏全部角色的美术效果、动画全帧、目标设备性能或宿主资源发布验收。
