# Codex OAuth Refresh Tools

## 中文简介

本项目是一组本地脚本，用于管理和刷新 Codex / OpenAI OAuth 账号凭证。它提供命令行批处理脚本和本地 WebUI，两者都只应在你自己的机器上运行。

## English Summary

Codex OAuth Refresh Tools is a local-only utility set for managing and refreshing Codex / OpenAI OAuth account credentials. It includes a command-line batch refresher and a localhost WebUI, and it is intended only for accounts you own or are authorized to manage.

## 开源协议

本项目使用 MIT License。选择 MIT 的原因是工具脚本体量小、复用场景偏个人和自动化集成，宽松协议更方便二次修改和私有部署。

## 风险警告

- 本项目不是 OpenAI 官方工具，也不代表 OpenAI、Codex 或 Microsoft 的官方支持方式。
- OAuth token、邮箱 refresh token、邮箱密码、取码平台 API key 都是高敏感凭证，泄露后可能导致账号被接管、滥用或封禁。
- 批量登录、批量刷新、自动读取邮件验证码可能触发平台风控、账号限制、封禁或违反相关服务条款；请只在你有权限的账号上使用。
- 本地 WebUI 默认监听 `127.0.0.1`，不要暴露到公网、局域网或共享服务器。
- 导入、导出和下载的 JSON 文件会包含完整 token；应只保存在受信任的本机目录，并加入 `.gitignore`。

## 需要的账号和信息

- OpenAI / Codex 登录邮箱：必需，用于触发 OpenAI OAuth 一次性验证码。
- Codex OAuth token：可选；已有账号文件里可包含 `id_token`、`access_token`、`refresh_token`，刷新成功后会写回。
- Microsoft / Outlook 邮箱 OAuth 信息：自动读取验证码时需要 `mailbox_client_id` 和 `mailbox_refresh_token`。
- 邮箱密码：可选，仅作为记录字段，脚本当前不会用密码登录邮箱。
- 第三方取码站信息：可选；如果使用备用接口，需要通过环境变量或参数提供 API key 和分组参数，仓库不内置任何私有 key。

## 账号 JSON 格式

默认账号文件名为 `codex_accounts.local.json`，这个文件被 `.gitignore` 排除。格式是 JSON 数组：

```json
[
  {
    "email": "user@example.com",
    "type": "codex",
    "expired": "",
    "last_refresh": "",
    "id_token": "OPENAI_ID_TOKEN_OPTIONAL",
    "access_token": "OPENAI_ACCESS_TOKEN_OPTIONAL",
    "refresh_token": "OPENAI_REFRESH_TOKEN_OPTIONAL",
    "mailbox_client_id": "00000000-0000-0000-0000-000000000000",
    "mailbox_refresh_token": "MICROSOFT_MAILBOX_REFRESH_TOKEN_OPTIONAL",
    "mailbox_password": "MAILBOX_PASSWORD_OPTIONAL",
    "mailbox_group": "default"
  }
]
```

邮箱导出文本也可导入，单行格式为：

```text
email@example.com----mailbox_password----microsoft_client_id----microsoft_refresh_token--------group
```

要求：

- `email` 必须是可接收 OpenAI 验证码的邮箱地址。
- `mailbox_client_id` 应为 Microsoft OAuth app/client id，通常是 UUID 格式。
- `mailbox_refresh_token` 必须属于对应邮箱账号。
- `id_token`、`access_token`、`refresh_token` 不要手写分享；只在本地刷新结果里保存。

## 安装

```powershell
npm install
```

这会安装项目声明的可选 Playwright 依赖，供命令行脚本和本地 WebUI 打开浏览器登录页。

如果不想安装本地依赖，也可以把 Playwright 安装路径放到 `PLAYWRIGHT_NODE_MODULES`。

## 使用

复制示例账号文件：

```powershell
Copy-Item .\examples\codex_accounts.example.json .\codex_accounts.local.json
```

命令行刷新：

```powershell
node .\scripts\codex-oauth-batch-refresh.mjs --accounts .\codex_accounts.local.json --limit 3
```

启动 WebUI：

```powershell
.\start-webui.ps1
```

然后打开：

```text
http://127.0.0.1:1466
```

可选环境变量：

```powershell
$env:CODE_SITE_URL = "https://example.com/"
$env:OUTLOOK007_API_KEY = "your_api_key"
$env:OUTLOOK007_PT = "your_group_pt"
$env:MAIL_PT_SOURCE = ".\mail-pt-source.local.txt"
```

## 验证

```powershell
npm run check
```

该检查只验证脚本语法，不会读取账号文件，也不会发起登录。
