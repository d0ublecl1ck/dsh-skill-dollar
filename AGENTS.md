# AGENTS.md

**定位**：DSH（DeepSeek Harness）插件 bundle —— 用 `$name` 手势调用 skill（对应内置的 `/name`），并让 composer 把 `$name` 当作蓝色文本引用。

## 怎么跑

- 装进 web profile（仓库根即插件目录）：
  ```sh
  dsh plugin --profile web add "$PWD"
  ```
- 回归测试：`node --test`（或 `npm test`），覆盖 transform、漂移告警、registry hook、排序/用量纯函数
- core 锚点自检：`node check-core-surface.mjs`（或 `npm run check:core`）；漂移退出 1，找不到已装 DSH 退出 2
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
- `bundle-patch.mjs` — conversation 扫描的两处替换 + `detectBundleState` 状态判定，host 与兜底共用
- `patch-core.mjs` — 旧 host 的磁盘兜底 CLI（复用 `bundle-patch.mjs`）
- `check-core-surface.mjs` — core 锚点自检 CLI（`inspectCoreSurface` 为纯函数，供测试断言）
- `test-bundle-patch.mjs`、`test-core-surface.mjs`、`test-skill-rank.mjs` — `node --test` 的回归测试
- `cordis.patch.yml` — bundle 层入口
- 触发字符固定 `$`，host/client 必须一致；改 patched 字节时递增 `TEXT_REF_PATCH_VERSION`
- 两处 core 锚点（`InputTriggerController.track`、`TEXT_REF_RE`）失效必须非静默：index.js 打一次 warn，`check-core-surface.mjs` 退出 1
- Desktop 用 generation 快照：改完仓库要重装到 Desktop profile，再 `Cmd/Ctrl+Shift+R` 重启 harness（窗口不退出）

## 当前状态

- 0.1.1：高亮改为 host 运行时补丁（`ClientModuleRegistry.bundleResource` + revision 加盐），DSH Desktop 0.1.7 已 live 验证；DSH 0.1.5 走 `patch-core.mjs`。
- 0.2.0：候选排序改为「名称前缀 → 名称子串 → 名称子序列 → 仅描述命中」，并列时最近使用 → 使用次数 → host 顺序（用量存 localStorage，上限 200）；两处 core 锚点加漂移自检（`check-core-surface.mjs`）与运行时 warn；`package.json` 声明 `dsh.compatibility.dshReleases`。
- 0.2.0 收尾：补 `LICENSE`（MIT，d0ublecl1ck）；仓库加 `dsh-plugin` topic 并向 `awesome-dsh-plugin` 提交收录 PR #6040；G1–G5 在 `dsh` 0.1.5-rc.3 下全绿。
- Desktop 已装 generation `dsh-skill-dollar+0.1.1+5f63edafeabd`；仓库已是 0.2.0，需在 Desktop 的插件管理面重建 generation 后按 `Cmd/Ctrl+Shift+R` 才加载新版本。
