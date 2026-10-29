# AGENTS.md

本仓库是 **EasyCLIProxyAPI** 的桌面端（Tauri + React + Rust），内核为上游 CLIProxyAPI。
给自动化 agent / 协作者的项目约定，**动手前必读**。

---

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `src/` | React 前端（页面、组件、样式、i18n） |
| `src-tauri/` | Rust 桌面端后端（进程管理、内核升级、App 更新） |
| `cpa-core/` | 打包进安装包的内核压缩包缓存 + `checksums.txt` |
| `core-version.txt` | **内核版本锁**，`portable.mjs` 据此定位 `cpa-core/` 里的压缩包 |
| `bin-work/` | `build.sh` 产出的便携目录（可执行文件 + 内核） |
| `tests/` | bun 单元测试 + Puppeteer 类 UI 测试 |
| `docs/release-notes/` | 各版本发布说明（`v0.3.x/{zh-CN,zh-TW,en,ja}.md`） |
| `scripts/` | 构建、便携打包、版本号、发布说明脚本 |

远端：

- `origin` → `framecy/EasyCLIProxyAPI`（个人 fork，日常提交到此）
- `upstream` → `router-for-me/EasyCLIProxyAPI`（上游，只拉不合入推送）

---

## 构建：必须走 build.sh

```bash
./build.sh
```

**不要直接用 `bun tauri build`。** `build.sh` 里有三个不可省略的步骤，直接调 tauri 会漏掉：

1. **注入 GitCode 镜像仓库**（关键）
   ```bash
   GITCODE_GUI_REPOSITORY=lzt404/EasyCLIProxyAPI
   GITCODE_CORE_REPOSITORY=lzt404/CLIProxyAPI
   ```
   这两个值通过 `option_env!` 在**编译期**写进二进制。漏掉会导致「应用版本检查」三个渠道全部失败：

   ```
   All application version check sources failed: GitHub: GitCode fallback is not configured for this build;
   gh-proxy.com: ...; ghfast.top: ...
   ```

   原因：官方 `portable-update-*.json` 清单里每个安装包都带 GitCode 备用下载地址，
   `validate_portable_update_asset_fallbacks()` 要求构建时配置了仓库信息才认可这些地址。
   即使 GitHub / gh-proxy / ghfast 都成功拿到清单，也会卡在同一处校验。

2. **跑 `scripts/portable.mjs`**：把可执行文件、`core-version.txt`、`portable-app.json`、
   `cpa-core/` 归档组装成 `bin-work/EasyCLIProxyAPI` 便携目录。

3. **校验内核归档 SHA-256**：与 `cpa-core/checksums.txt` 比对，不一致直接失败。

### 构建前先确认能跑 git

若机器上 Xcode 许可证未同意，`/usr/bin/git` 会直接报错退出（`xcode-select` 指向 Xcode 时）。
临时绕过：

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

---

## 版本号

| 位置 | 含义 | 修改方式 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` `[package].version` | **App 版本唯一来源** | `node scripts/set-version.mjs <版本>` |
| `core-version.txt` | 内核版本锁 | 手改，同时把对应归档放进 `cpa-core/` |
| `bin-work/portable-app.json` | 便携清单 | 由 `portable.mjs` 自动生成，勿手改 |

`src-tauri/tauri.conf.json` **没有** `version` 字段，版本从 `Cargo.toml` 继承。
注意 `bun tauri build --no-bundle` **不会生成 Info.plist**；覆盖安装到 `/Applications` 后
若版本显示不对，用 PlistBuddy 同步：

```bash
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString <版本>" /Applications/EasyCLIProxyAPI.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion <版本>" /Applications/EasyCLIProxyAPI.app/Contents/Info.plist
```

---

## 内核升级

内核来自上游 `router-for-me/CLIProxyAPI`，本仓库只锁版本、不打补丁。

1. 改 `core-version.txt`
2. 下载对应平台的 `CLIProxyAPI_<版本>_<os>_<arch>.tar.gz` 到 `cpa-core/`
3. 同步 `cpa-core/checksums.txt`（**必须**，`portable.mjs` 依赖它做校验）
4. 跑 `./build.sh` 重新打包

运行时内核所在目录（macOS）：`~/Library/Application Support/com.cpa.gui/cpa-core/`
其中 `config.yaml`、`plugins/`、`oauth/`、`static/` 是**用户数据，升级时不得覆盖**。

### macOS 陷阱：替换内核二进制后会被系统杀掉

若手动替换运行时目录里的 `cli-proxy-api`，执行时报 `Killed: 9`。
这是 macOS 对下载文件的代码签名校验：官方包是 adhoc 链接器签名，同名同标识的新旧文件签名不相容。
修复：

```bash
codesign --force -s - ~/"Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api"
```

---

## 测试基线

```bash
bunx tsc --noEmit   # 类型检查，必须 0 错误
bun test            # 1028 pass / 8 fail
```

**那 8 个失败是上游 v0.3.55 自带的**，与本地改动无关（CSS lint、i18n 边界、配额卡片等）。
判断回归的方法：拿纯上游代码建临时 worktree 跑同一套测试对比，**失败数量一致即可认为无回归**。

```bash
git worktree add --detach /tmp/ref upstream/main
ln -s "$PWD/node_modules" /tmp/ref/node_modules
(cd /tmp/ref && bun test)
```

---

## 合并上游

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
git fetch upstream main
git branch -f "backup/pre-<版本>-$(date +%Y%m%d-%H%M%S)"   # 先留回退点
git merge upstream/main --no-commit --no-ff
```

合并前先确认没有残留的 `MERGE_HEAD`，否则 `git merge` 会直接拒绝执行。

**长期存在的冲突点：OAuth 卡片身份类**

本地刻意让 Vertex 卡和插件卡**不挂** `.oauth-card`，改用 `.vertex-login-card` / `.plugin-oauth-card`，
原因是 `.oauth-card` 的数量被多个 UI 测试用来校验内置 provider 列表，混入会算多。
上游重构时会反复把 `.oauth-card` 加回来 —— **合并时保持本地意图**：

```tsx
// 正确
<section className="panel surface-panel vertex-login-card">
<section className="panel surface-panel plugin-oauth-card">
// 错误：会破坏 oauth-card 计数
<section className="panel surface-panel oauth-card vertex-login-card">
```

**样式职责边界**：卡片外观（边框、背景、阴影）由共享类 `.surface-panel` 负责。
身份类只写**布局**（`display` / `flex` / `gap` / `margin-top`），
不要写 `border-color` / `box-shadow` 等外观属性，否则 `tests/surfaceControls.test.ts` 会失败。

合并完成后：

```bash
git show upstream/main:core-version.txt   # 上游的内核锁通常落后，本地更新的话保留本地值
node scripts/set-version.mjs <上游版本>
bunx tsc --noEmit && bun test
```

---

## 覆盖安装到 /Applications

```bash
osascript -e 'quit app "EasyCLIProxyAPI"'          # 先优雅退出，内核会随之停止
cp -f bin-work/EasyCLIProxyAPI /Applications/EasyCLIProxyAPI.app/Contents/MacOS/cpa-gui
# 版本号有变化时同步 Info.plist（见上文）
open -a EasyCLIProxyAPI
```

验证清单：

- `ps aux | grep cpa-gui` 与 `cpa-core/cli-proxy-api` 两个进程都在
- `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8317/v1/models` 返回 **401**（正常鉴权响应，说明服务活着）
- 内核日志（`~/.cli-proxy-api/logs/core-start-output.log`）无新增 `[ERROR]`

---

## 约定

- `config.yaml` 结构以随内核包发布的 `config.example.yaml` 为准，升级内核后比对顶层字段
- 提交信息用 Conventional Commits（`fix(ui):` / `feat(plugins):` / `chore(release):`）
- 内核与 App 是两套独立版本号，勿混用
