# AGENTS.md

**定位**：DSH（DeepSeek Harness）插件 bundle —— 用 `$name` 手势调用 skill（对应内置的 `/name`），并让 composer 把 `$name` 当作蓝色文本引用。

## 怎么跑

- 装进 web profile（仓库根即插件目录）：
  ```sh
  dsh plugin --profile web add /Users/d0ublecl1ck/dsh-skill-dollar
  ```
- 回归测试：`node test-bundle-patch.mjs`（或 `npm test`）
- 验证梯子 G1–G5：
  ```sh
  node ~/.agents/skills/create-dsh-plugin/scripts/verify-dsh-plugin.mjs --plugin-dir .
  ```
- 旧 host（revision 由内容派生，如 DSH 0.1.5）磁盘兜底：
  ```sh
  node patch-core.mjs --file <conversation>/lib/client.js
  ```

## 技术栈

- Node ESM。host：`index.js`（Cordis 插件，导出 `name`/`apply`/`inject`）；client：`client.js`（`window.__ModuleLoader__.load` 注册）
- 无运行时依赖；host 只 import `node:crypto` 和本地 `./bundle-patch.mjs`（link 安装必须能解析）

## 目录与约定

- `index.js` — host 半侧：`$name` 注入 + 运行时改写 conversation bundle
- `client.js` — client 半侧：`$` 候选 source + `InputTriggerController.track` 补丁
- `bundle-patch.mjs` — conversation 扫描的两处替换，host 与兜底共用
- `patch-core.mjs` — 旧 host 的磁盘兜底 CLI（复用 `bundle-patch.mjs`）
- `test-bundle-patch.mjs` — 回归测试
- `cordis.patch.yml` — bundle 层入口
- 触发字符固定 `$`，host/client 必须一致；改 patched 字节时递增 `TEXT_REF_PATCH_VERSION`
- Desktop 用 generation 快照：改完仓库要重装到 Desktop profile，再 `Cmd/Ctrl+Shift+R` 重启 harness（窗口不退出）

## 当前状态

- 0.1.1：高亮改为 host 运行时补丁（`ClientModuleRegistry.bundleResource` + revision 加盐），DSH Desktop 0.1.7 已 live 验证；DSH 0.1.5 走 `patch-core.mjs`。
- Desktop 已装 generation `dsh-skill-dollar+0.1.1+5f63edafeabd`。
