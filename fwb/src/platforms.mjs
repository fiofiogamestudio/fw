/** Platform routes describe build prerequisites, never storefront certification. */
const godotWeb = 'https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html';
const douyin = 'https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/guide/game-engine/godot/godot-engine-integration-guide';

/** Technology identifies reusable resource preparation; category identifies delivery. */
export const targetCategories = Object.freeze([
  { id: 'static-web', label: '静态网页', technology: 'web' },
  { id: 'h5', label: 'H5 平台', technology: 'web' },
  { id: 'minigame', label: '小游戏', technology: 'web' },
  { id: 'android', label: 'Android', technology: 'native' },
  { id: 'ios', label: 'iOS', technology: 'native' },
].map(category => Object.freeze(category)));

export const targets = Object.freeze([
  { id: 'web', label: '静态网页（浏览器）', family: 'web', category: 'static-web', technology: 'web', status: 'supported', platform: 'Web', preset: 'Web', extension: '.html',
    requirements: ['Godot 4 GDScript', 'Compatibility 渲染器', '匹配版本的 Web 导出模板'], sources: [godotWeb] },
  { id: 'poki', label: 'Poki', family: 'web', category: 'h5', technology: 'web', status: 'experimental', platform: 'Web', preset: 'Web', extension: '.html',
    requirements: ['Web 构建条件', 'Poki SDK 生命周期接入', '单线程', 'Poki Inspector 和平台验收'], sources: [godotWeb, 'https://developers.poki.com/guide/sdk-godot', 'https://developers.poki.com/guide/inspector'] },
  { id: 'taptap-h5', label: 'TapTap（App 内即玩）', family: 'web', category: 'h5', technology: 'web', status: 'experimental', platform: 'Web', preset: 'Web', extension: '.html',
    requirements: ['Web 构建条件', '单线程', 'TapTap 客户端真机及上传验收'], sources: ['https://developer.taptap.cn/minigameapidoc/quick-start/guide/minigames-intro/', godotWeb] },
  { id: 'wechat-minigame', label: '微信小游戏', family: 'minigame', category: 'minigame', technology: 'web', status: 'unverified', platform: null, preset: 'WeChat', extension: '.zip',
    requirements: ['经过实测的 Godot 引擎适配', 'Web 导出与转换脚本，或自有小游戏导出 preset', '匹配引擎和 SDK 的本地验证证据'], sources: ['https://developers.weixin.qq.com/minigame/dev/guide/game-engine/common-adaptation.html'] },
  { id: 'douyin-minigame', label: '抖音小游戏', family: 'minigame', category: 'minigame', technology: 'web', status: 'experimental', platform: null, preset: 'Douyin', extension: '.zip',
    requirements: ['官方目前列出的 Godot 4.5', 'GDScript + Compatibility', '无 GDExtension 和线程', '官方 SDK 及经过验证的导出 preset'], sources: [douyin, 'https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/guide/game-engine/godot/sdk-usage-guide'] },
  { id: 'google-play', label: 'Google Play / Android', family: 'android', category: 'android', technology: 'native', status: 'supported', platform: 'Android', preset: 'Android', extension: '.aab',
    requirements: ['Android SDK', 'JDK 17 或更新版本', '匹配的 Android 导出模板', '正式包使用 Gradle、AAB 和签名'], sources: ['https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_android.html'] },
  { id: 'app-store', label: 'App Store / iOS', family: 'ios', category: 'ios', technology: 'native', status: 'supported', platform: 'iOS', preset: 'iOS', extension: '.zip',
    requirements: ['macOS 构建机', 'Xcode 和 iPhoneOS SDK', '匹配的 iOS 导出模板', '签名后归档与 TestFlight 验收'], sources: ['https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_ios.html', 'https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds'] },
].map((target) => Object.freeze({ ...target, requirements: Object.freeze(target.requirements), sources: Object.freeze(target.sources) })));

export function getTarget(id) {
  return targets.find((target) => target.id === id);
}

export function retiredTargetMessage(id) {
  if (id === 'taptap-minigame') return 'FWB 已停止维护 taptap-minigame（TapTap 普通小游戏）。请在 fwb.project.json 中移除该目标或设置 enabled:false，再配置 taptap-h5（preset: Web）。请重新构建 H5 包并在手机 TapTap App 内验收，不能直接转换旧包。';
}
