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

> **本机没有 `npm` 命令。** DeepSeek Harness 自带的是 `node.exe` 和一个 pnpm 包，没有全局 npm，所以 `npm login` / `npm publish` 都会报“无法将 npm 项识别为 cmdlet”。用下面的一键脚本（内部调用自带的 node + pnpm）即可，不需要额外安装 Node。

### 3.1 一键脚本

```powershell
powershell -ExecutionPolicy Bypass -File D:\dsh-plugin\dsh-workspace-memory\publish.ps1
```

脚本会依次：跑测试 → 检查是否已登录（未登录会打印一个 npm 登录链接，在浏览器里完成）→ 发布。

### 3.2 账号开了两步验证（2FA）怎么办

npm 要求发布必须满足 2FA，否则返回：

```
403 Forbidden - PUT https://registry.npmjs.org/<包名> - Two-factor authentication
or granular access token with bypass 2fa enabled is required to publish packages.
```

**用一次性验证码发布**（当前唯一稳妥的做法）：

```powershell
powershell -ExecutionPolicy Bypass -File D:\dsh-plugin\dsh-workspace-memory\publish.ps1 -Otp 123456
```

`123456` 换成认证器里当下的 6 位数字，**每次发布都要重新取**。

#### 为什么不再推荐"长期令牌"

npm 正在分两步废弃 2FA-bypass 令牌（Granular Access Token 里勾 *Bypass two-factor authentication* 的那种），依据是 npm v12 公告《install-time security defaults and GAT bypass 2FA deprecation》：

| 时间 | 变化 |
|---|---|
| 2026 年 8 月起 | 这类令牌**不能再跳过 2FA 做账号类操作**：创建/删除令牌、改密码/邮箱/2FA、改包权限或维护者、管理组织与团队 |
| 2027 年 1 月前后 | 这类令牌**不能再直接发布**；只剩"读取私有包"和"暂存发布"（staged publish），发布要由人用 2FA 批准 |

也就是说：现在（2026 年 11 月）用令牌发布**还能用**，但两个月后就会失效，不值得写进流程。以 `-Otp` 为准。

#### 自动化场景怎么发

- **Trusted Publishing（OIDC）**：在 npm 包里绑定 GitHub Actions，由工作流身份直接发布，不需要任何长期令牌；
- **Staged publishing**：先 `pnpm stage` 暂存，再由人用 2FA 批准，适合"机器准备、人把关"。

#### 与 npm v12 的另一处无关影响

npm v12 把 `allowScripts`、`--allow-git`、`--allow-remote` 的默认值改成了关闭。本插件**不受影响**：`package.json` 没有 `preinstall`/`install`/`postinstall` 脚本，也没有 git 或远程 tarball 依赖（`dependencies` 为空）。

### 3.3 手动等价步骤

```powershell
# 变量：DSH 自带的 node 与 pnpm
$node = "C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\TJ_ZYS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

# 一次性：登录（会打印一个 https://www.npmjs.com/login?next=... 链接，浏览器里完成）
& $node $pnpm login

# 确认身份与包名
& $node $pnpm whoami
& $node $pnpm view dsh-workspace-memory version   # 报 404 说明包名可用

# 发布（账号开了 2FA 时加 --otp <当时代码>）
cd D:\dsh-plugin\dsh-workspace-memory
& $node $pnpm publish --access public --no-git-checks
```

> 用 `pnpm login` 登录后，发布时若仍报 2FA，就在命令末尾加 `--otp 123456`（认证器里的 6 位数字）。

### 3.4 验证

```powershell
& $node $pnpm view dsh-workspace-memory version
```

返回 `0.1.7` 即发布成功。之后更新只需递增 `version` 再跑同一脚本。

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
