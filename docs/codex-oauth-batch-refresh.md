# Codex OAuth batch refresh

这个工具用于在本机刷新 `codex_accounts.local.json` 里的 Codex / OpenAI OAuth 授权。

它会自动完成：

- 筛选未刷新账号
- 打开 OpenAI OAuth 登录页
- 输入邮箱并触发一次性验证码
- 等待你在终端粘贴验证码
- 提交验证码、换取 token、写回 JSON
- 每次运行前创建备份

它不会做：

- 自动读取邮箱验证码
- 保存验证码
- 在终端打印 access token、refresh token 或 id token

## 用法

从项目根目录运行：

```powershell
node .\scripts\codex-oauth-batch-refresh.mjs --accounts .\codex_accounts.local.json --limit 3
```

建议先用 `--limit 3` 试跑。默认一次只处理一个账号，最稳。

只刷新指定序号：

```powershell
node .\scripts\codex-oauth-batch-refresh.mjs --indexes 5,6,7
```

尝试每批打开 2 个账号：

```powershell
node .\scripts\codex-oauth-batch-refresh.mjs --limit 6 --batch 2
```

如果 OpenAI 登录页出现 `Route Error` 或 400，改回默认单账号模式。

## WebUI 用法

从项目根目录启动本地网页控制台：

```powershell
node .\scripts\codex-oauth-webui.mjs
```

也可以一键启动并自动打开浏览器：

```powershell
.\start-webui.ps1
```

然后打开：

```text
http://127.0.0.1:1466
```

网页里可以筛选账号、选择账号、打开验证码页、输入验证码并提交。手动模式不会读取邮箱验证码，也不会在页面里显示 token；自动刷新模式会在账号配置了邮箱 OAuth 授权时读取验证码邮件。

界面内置了取码网站快捷入口：

- `一键开始`：复制当前邮箱，并触发 OpenAI 验证码邮件。
- `复制邮箱`：复制当前选中账号邮箱。
- `打开取码网站`：打开 `CODE_SITE_URL` 或 `--code-site-url` 配置的取码网站。
- `复制并打开`：复制当前邮箱后打开取码网站，方便在取码网站里搜索验证码。

界面也内置了队列工作台：

- 默认自动选中第一个自动待刷新账号。
- `上一个` / `下一个` 会在自动待刷新账号之间切换。
- `自动待刷新` 队列只包含当前已过期且带可用邮箱授权的账号；凭证仍有效、缺少邮箱授权或邮箱授权不可读的账号不会进入自动刷新队列。
- 自动刷新过程中如果检测到账号被停用、封禁、锁定、不存在、不符合使用条件或 OpenAI 授权 403 等明确异常，会把账号标记为异常并移出自动刷新队列。
- 自动取码会优先扫描 Outlook 收件箱、垃圾邮件、已删除、归档和其他邮件；如果配置了备用取码接口，也会尝试备用接口。如果邮件内容显示账号停用等异常，也会标记为异常账号。
- 勾选 `提交成功后自动选中下一个自动待刷新账号` 后，成功刷新一个账号会自动跳到下一个。
- 每个账号在列表里独立显示状态；已打开验证码页的账号会显示为 `等待验证码`，切换账号不会覆盖其他账号的状态。
- 刷新流程按单账号进行，避免 OpenAI 登录页因为并发过高报错。
- 刷新页内嵌了取码网站区域，支持复制当前邮箱、刷新取码网站、放大、缩小和恢复原始大小。
- `查看报错` 会把本地 WebUI 服务日志和错误日志显示在页面日志区。
- `提交验证码` 会创建后台任务并立即恢复页面操作；任务进度、等待回调、token 交换和失败原因会持续显示在页面日志区。
- 刷新页右侧按内容自然展开，可以用页面滚轮上下滑动；取码网站区域使用 1440px 桌面画布，并默认按当前容器宽度自动缩放，方便查看完整邮箱网站。

## Playwright 模块路径

如果没有在项目目录运行 `npm install`，可以把 `PLAYWRIGHT_NODE_MODULES` 指向已经安装 Playwright 的 `node_modules` 目录。脚本会先从该目录解析 `playwright` 包，再回退到项目本地 `node_modules`。

## 凭证管理页面

打开：

```text
http://127.0.0.1:1466/credentials
```

凭证管理页面用于下载、导入和检查凭证：

- 勾选一个或多个账号后点 `下载已勾选`，会下载所选账号的完整 JSON 凭证。
- 点 `下载全部已刷新`，会下载所有已刷新账号的完整 JSON 凭证。
- `导入凭证` 可以选择 JSON 文件或 `邮箱----密码----client_id----refresh_token--------分组` 格式的邮箱导出文本；邮箱已存在则更新，邮箱不存在则追加为待刷新账号，导入前会自动备份。
- `检查已勾选` 会检查已勾选账号的本地过期时间和 token 到期时间。
- `检查全部` 会统计全部账号里有效、已过期、未知 token 状态的数量。

## 回滚

脚本每次写入账号文件前都会生成：

```text
codex_accounts.local.json.bak_batch_<timestamp>
```

需要回滚时，用对应备份覆盖 `codex_accounts.local.json`。
