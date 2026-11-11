# 发布与上架

维护者文档：怎么把插件发到 GitHub、npm，并让它出现在 DSH 插件市场里。

面向使用者的安装步骤在 [README.md](README.md#安装)。

---

## 0. 先改掉占位符

`package.json` 与 `CHANGELOG.md` 里的 `CHANGE-ME` 是你的 GitHub 用户名或组织名：

```powershell
# 在插件目录执行，把 CHANGE-ME 换成你的名字
$owner = "your-name"
Get-ChildItem package.json, CHANGELOG.md, README.md -Recurse |
  ForEach-Object { (Get-Content $_ -Raw) -replace 'CHANGE-ME', $owner | Set-Content -NoNewline $_ }
```

改完用 `Select-String -Path package.json,CHANGELOG.md -Pattern 'CHANGE-ME'` 确认没有残留。

同时确认 `package.json` 里：

| 字段 | 说明 |
|---|---|
| `name` | npm 包名，默认 `dsh-workspace-memory`；被占用就换一个（例如 `@your-scope/dsh-workspace-memory`），`cordis.patch.yml` 里的 `name` 也要同步 |
| `version` | 语义化版本，每次发布必须递增 |
| `private` | **不能有**，否则 `npm publish` 拒绝 |
| `dsh.bundle.patch` | 指向 `./cordis.patch.yml`，市场与 `install_bundle` 都靠它 |
| `files` | 只打运行时文件；`test/` 不进包 |
| `engines.dsh` | 已声明 `>=0.2.2-rc.1`（实测版本） |

---

## 1. 打包

```powershell
# 用 DSH 自带的 node + pnpm，避免依赖全局环境
$node = "C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

& $node $pnpm pack --pack-destination ..\dist
```

产物：`dist\dsh-workspace-memory-<version>.tgz`。它会打印 `Tarball Contents`，核对一下应包含：

```
CHANGELOG.md  cordis.patch.yml  icon.svg  LICENSE  package.json  PUBLISHING.md  README.md
lib/*.js  locale/en.json  locale/zh.json
```

**不应**包含 `test/`、`.gitignore`、`node_modules/`。

发版前跑一遍测试：

```powershell
& $node --test
```

---

## 2. 上传到 GitHub

仓库已经初始化好（`main` 分支、首个提交、`v0.1.7` 标签、`origin` 已指向 `yusheng-zhu12/dsh-workspace-memory`），所以只剩推送。

### 2.1 在网页上建空仓库（英文界面）

1. 右上角 **+** → **New repository**；
2. **Repository name** 填 `dsh-workspace-memory`；
3. **Description**（可选）填一句：`Workspace-scoped durable memory for DeepSeek Harness`；
4. 选 **Public**；
5. **不要**勾选 *Add a README file*、*Add .gitignore*、*Choose a license*（本地已有，勾了会冲突）；
6. 点 **Create repository**。

### 2.2 推送本地提交

```powershell
cd D:\dsh-plugin\dsh-workspace-memory
git push -u origin main --tags
```

第一次推送会弹出 GitHub 登录（Git Credential Manager）。若没有弹窗，就用 **Settings → Developer settings → Personal access tokens** 建一个带 `repo` 权限的 token，在提示输入密码时粘贴 token（GitHub 不接受账号密码）。

### 2.3 完善仓库信息

在仓库页面右侧 **About** 旁的齿轮 → 填 **Description**，在 **Topics** 里加：
`deepseek-harness`、`dsh`、`dsh-plugin`、`memory`、`cordis`、`agent-memory`。

### 2.4 建 Release

1. 仓库右侧 **Releases** → **Draft a new release**；
2. **Choose a tag** 选已存在的 `v0.1.7`（不要新建）；
3. **Release title** 填 `v0.1.7`；
4. 描述里粘贴 `CHANGELOG.md` 的 `## [0.1.7]` 小节；
5. **Attach binaries** 上传 `dist\dsh-workspace-memory-0.1.7.tgz`（方便离线安装）；
6. 点 **Publish release**。

之后每次更新：

```powershell
# 改代码 → 改 CHANGELOG → 升 version → 测试 → 打包
git add -A
git commit -m "fix: ..."
git tag v0.1.8
git push && git push --tags
```

---

## 3. 发布到 npm

市场与 `dsh plugin add` 都按 npm 包名解析，所以**先发布 npm**。

```powershell
# 一次性：登录（需要 npm 账号，开启 2FA 时用 --otp）
npm login

# 确认包名没被占用
npm view dsh-workspace-memory version

# 发布（package.json 已设 publishConfig.access=public）
& $node $pnpm publish --access public --no-git-checks
```

验证：

```powershell
npm view dsh-workspace-memory version dist.tarball
```

之后更新只需递增 `version` 再 `pnpm publish`；`npm view` 里能看到新版本就说明生效。

> 如果包名被占用，改成 `@<scope>/dsh-workspace-memory` 发布，并把 `cordis.patch.yml` 的 `name` 一起改掉。

---

## 4. 上架插件市场

DSH 的插件市场（`dshmarket` / Plugins → Discover）**不直接搜 npm**，它读的是策展目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 生成的 `plugins.json`。目录条目把插件映射到 npm 包名。

所以上架 = 往那个仓库提一个 PR，加**一条**条目，通常一天内同步到市场和网站。

步骤：

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>，先读它的 `README` / `CONTRIBUTING`，照现有条目的格式写（不同时间格式可能变，以仓库现状为准）。
2. 条目里至少要能对上：显示名、npm 包名（`dsh-workspace-memory`）、GitHub 仓库地址、一句话描述、分类/标签。
3. 提交 PR，说明这是 DSH Host 插件、已发布到 npm、仓库公开。
4. 合并后等 CI 刷新 `plugins.json`，然后在 DSH 里 **Plugins → Discover** 搜索验证。

> 本会话没有可用的网络抓取工具（`web_fetch` 的 provider 未注册），因此没能在这里核对目录条目的确切字段名。请以仓库里现有条目的实际写法为准；字段拼错会被 CI 拒绝。

另外，用户也可以不依赖市场，直接加索引源：

**Plugins → Discover → Index sources** 添加 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（官方目录的 npm 镜像，比 GitHub Pages 在国内更稳）。

---

## 5. 发版检查清单

- [ ] `CHANGELOG.md` 已写本次变更
- [ ] `package.json` 的 `version` 已递增
- [ ] 没有 `CHANGE-ME` 残留
- [ ] `node --test` 全绿
- [ ] `pnpm pack` 的 `Tarball Contents` 没有多余文件
- [ ] 用 tarball 装一次，`Tool.listTools` 能看到六个工具
- [ ] git tag 与 npm version 一致（例如都叫 `0.1.1` / `v0.1.1`）
- [ ] GitHub Release 附上 `.tgz`
- [ ] 市场目录里的条目（若字段含版本）同步更新

---

## 6. 已知坑

- **别用 `remove_bundle` 卸载目录链接安装**：实测会清空源码目录内容（本仓库的 `test/` 就是这样丢过一次，后来从 tarball 恢复）。开发时先提交 git，或改用 tarball 安装。
- **包名与 `cordis.patch.yml` 的 `name` 必须一致**，否则 `install_bundle` 装上后 Loader 找不到模块。
- **`files` 漏写文件**会导致装完缺文件：`locale/*.json`、`icon.svg`、`cordis.patch.yml` 都是市场展示与激活所需。
- **升级已安装的包需要重启 DSH**：`remove_bundle` + `install_bundle` 会把新文件装进 profile，但运行中的进程仍持有旧模块——实测替换后新增的工具不会出现，行为也不变。只有重启（关掉再打开 DSH）才会加载新的模块代际。发版后要验证，请先重启再测。
