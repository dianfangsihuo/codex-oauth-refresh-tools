#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const DEFAULT_ACCOUNTS = path.join(process.cwd(), "codex_accounts.local.json");
const DEFAULT_CUTOFF = "2026-06-27T00:00:00+08:00";
const CODE_SITE_URL = argValue("--code-site-url", process.env.CODE_SITE_URL || "");
const MAIL_PT_SOURCE = argValue("--mail-pt-source", process.env.MAIL_PT_SOURCE || "");
const OUTLOOK007_API_KEY = argValue("--outlook007-api-key", process.env.OUTLOOK007_API_KEY || "");
const DEFAULT_OUTLOOK007_PT = argValue("--outlook007-pt", process.env.OUTLOOK007_PT || "");
const PORT = Number(argValue("--port", "1466"));
const ACCOUNTS_PATH = path.resolve(argValue("--accounts", DEFAULT_ACCOUNTS));
const LOG_OUT_PATH = path.resolve(argValue("--out-log", path.join(process.cwd(), "codex-oauth-webui.log")));
const LOG_ERR_PATH = path.resolve(argValue("--err-log", path.join(process.cwd(), "codex-oauth-webui.err.log")));
const CUTOFF_TS = Date.parse(argValue("--cutoff", DEFAULT_CUTOFF));
const HEADLESS = process.argv.includes("--headless");

const sessions = new Map();
const jobs = new Map();
let backupPath = "";
let playwright = null;

const emailPtMap = new Map();
function loadEmailPtMap() {
  if (!MAIL_PT_SOURCE) return;
  try {
    const mail1Path = path.resolve(MAIL_PT_SOURCE);
    if (fs.existsSync(mail1Path)) {
      const content = fs.readFileSync(mail1Path, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line.trim().replace(/,$/, ""));
          if (obj.email) {
            const apiurl = obj.mailbox_url || (obj.mailbox && obj.mailbox.mailapi_url);
            if (apiurl) {
              const urlObj = new URL(apiurl);
              const pt = urlObj.searchParams.get("pt");
              if (pt) {
                emailPtMap.set(obj.email.toLowerCase(), pt);
              }
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error(`Failed to load mail1.txt mappings: ${err.message}`);
  }
}
loadEmailPtMap();

function getPtForEmail(email) {
  const emailKey = String(email || "").toLowerCase();
  if (emailPtMap.has(emailKey)) {
    return emailPtMap.get(emailKey);
  }
  if (emailPtMap.size > 0) {
    return emailPtMap.values().next().value;
  }
  return DEFAULT_OUTLOOK007_PT;
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function loadPlaywright() {
  const roots = [
    process.env.PLAYWRIGHT_NODE_MODULES,
    path.resolve("node_modules"),
  ].filter(Boolean);

  for (const root of roots) {
    try {
      const resolved = require.resolve("playwright", { paths: [root] });
      return require(resolved);
    } catch {
      // Continue through known local module roots.
    }
  }

  throw new Error("Playwright was not found. Run: npm install playwright");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makePkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function authUrl(pkce) {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("originator", "codex_vscode");
  return url.toString();
}

function readAccounts() {
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
}

function writeAccounts(accounts) {
  ensureBackup();
  fs.writeFileSync(ACCOUNTS_PATH, `${JSON.stringify(accounts, null, 2)}\n`, "utf8");
}

function ensureBackup() {
  if (backupPath) return;
  backupPath = `${ACCOUNTS_PATH}.bak_webui_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(ACCOUNTS_PATH, backupPath);
}

function parseDate(value) {
  return new Date(String(value).replace(/\//g, "-")).getTime() || 0;
}

function decodeJwtExp(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const data = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return Number(data.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function credentialStatus(account) {
  const metadataExpiry = parseDate(account.expired);
  const accessExpiry = decodeJwtExp(account.access_token);
  const idExpiry = decodeJwtExp(account.id_token);
  const tokenExpiry = Math.max(accessExpiry, idExpiry);
  const referenceExpiry = tokenExpiry || metadataExpiry;
  const expired = referenceExpiry ? referenceExpiry <= Date.now() : true;
  return {
    expired,
    metadataExpired: metadataExpiry ? metadataExpiry <= Date.now() : true,
    tokenExpired: tokenExpiry ? tokenExpiry <= Date.now() : null,
    tokenExpiresAt: tokenExpiry ? formatLocalDate(new Date(tokenExpiry)) : "",
  };
}

function redactMailSubject(subject) {
  return String(subject || "").replace(/\b\d{6}\b/g, "******").slice(0, 120);
}

async function mailboxDiagnostics(account, top = 8) {
  if (!account.mailbox_client_id || !account.mailbox_refresh_token) {
    throw new Error("当前账号缺少邮箱授权字段");
  }

  const params = new URLSearchParams();
  params.append("client_id", account.mailbox_client_id);
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", account.mailbox_refresh_token);

  const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
    method: "POST",
    body: params,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`邮箱授权换取失败：${tokenJson.error || tokenRes.status}`);
  }

  const foldersById = new Map();
  for (const folder of [
    { id: "Inbox", label: "收件箱" },
    { id: "JunkEmail", label: "垃圾邮件" },
    { id: "DeletedItems", label: "已删除" },
    { id: "Archive", label: "归档" },
    { id: "Clutter", label: "其他邮件" },
  ]) {
    foldersById.set(folder.id, folder);
  }

  try {
    const folderEndpoint = new URL("https://outlook.office.com/api/v2.0/me/MailFolders");
    folderEndpoint.searchParams.set("$top", "50");
    folderEndpoint.searchParams.set("$select", "Id,DisplayName");
    const folderRes = await fetch(folderEndpoint, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const folderJson = await folderRes.json().catch(() => ({}));
    if (Array.isArray(folderJson.value)) {
      for (const folder of folderJson.value) {
        if (folder.Id && !foldersById.has(folder.Id)) {
          foldersById.set(folder.Id, {
            id: folder.Id,
            label: folder.DisplayName || folder.Id,
          });
        }
      }
    }
  } catch {
    // The well-known folders above are enough for a useful fallback.
  }

  const results = [];
  for (const folder of foldersById.values()) {
    const endpoint = new URL(`https://outlook.office.com/api/v2.0/me/MailFolders/${encodeURIComponent(folder.id)}/messages`);
    endpoint.searchParams.set("$top", String(top));
    endpoint.searchParams.set("$orderby", "ReceivedDateTime desc");
    endpoint.searchParams.set("$select", "Subject,ReceivedDateTime");
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data.value) ? data.value.map((message) => {
      const subject = String(message.Subject || "");
      return {
        received: message.ReceivedDateTime || "",
        relevant: /登录代码|验证码|verification code|登入码|OpenAI|ChatGPT/i.test(subject),
        subjectPreview: redactMailSubject(subject),
      };
    }) : [];
    results.push({
      folder: folder.id,
      label: folder.label,
      status: res.status,
      ok: res.ok,
      error: data.error && (data.error.code || data.error.message) || "",
      items,
    });
  }

  return results;
}

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function accountSummary(account, index) {
  const refreshed = parseDate(account.expired) >= CUTOFF_TS;
  const status = credentialStatus(account);
  const mailboxReady = mailboxReadable(account);
  return {
    index: index + 1,
    email: account.email,
    last_refresh: account.last_refresh || "",
    expired: account.expired || "",
    refreshed,
    expiredNow: status.expired,
    tokenExpired: status.tokenExpired,
    tokenExpiresAt: status.tokenExpiresAt,
    mailboxReady,
    autoRefreshable: autoRefreshableAccount(account),
    autoRefreshBlocked: Boolean(account.auto_refresh_blocked),
    autoRefreshBlockReason: account.auto_refresh_block_reason || "",
    activeSession: [...sessions.values()].some((session) => session.index === index),
  };
}

function autoRefreshableAccount(account) {
  if (account.auto_refresh_blocked) return false;
  if (!mailboxReadable(account)) return false;
  return credentialStatus(account).expired;
}

function abnormalAccountReason(text) {
  const body = String(text || "");
  if (/account_deactivated|access deactivated|账号已被删除或停用|账户已被删除或停用|account (?:has been )?(?:deactivated|disabled|suspended|banned)/i.test(body)) {
    return "OpenAI account is deactivated or suspended";
  }
  if (/account_not_found|user_not_found|账号不存在|账户不存在|找不到账号|找不到账户/i.test(body)) {
    return "OpenAI account was not found";
  }
  if (/account_locked|temporarily locked|账号已锁定|账户已锁定|暂时锁定/i.test(body)) {
    return "OpenAI account is locked";
  }
  if (/not eligible|not allowed|无法使用|不能使用|不符合.*条件|不允许/i.test(body)) {
    return "OpenAI account is not eligible";
  }
  if (/Route Error\s*\(403\)|糟糕，出错了|Invalid content type/i.test(body)) {
    return "OpenAI auth route error";
  }
  return "";
}

function mailboxReadable(account) {
  if (!account || !account.mailbox_client_id || !account.mailbox_refresh_token) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(account.mailbox_client_id));
}

function codeInputLocator(page) {
  return page.locator([
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="验证码"]',
    'input[aria-label*="验证码"]',
    'input[aria-label*="code" i]',
    'input[type="text"]',
  ].join(", ")).first();
}

async function hasCodeInput(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  const selector = [
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="验证码"]',
    'input[aria-label*="验证码"]',
    'input[aria-label*="code" i]',
    'input[type="text"]',
  ].join(", ");

  while (Date.now() < deadline) {
    const visibleInput = await page.locator(selector).evaluateAll((inputs) => inputs.some((input) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })).catch(() => false);
    if (visibleInput) return true;

    const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (/检查你的收件箱|重新发送电子邮件|验证码|verification code|Check your inbox/i.test(body)) return true;
    await page.waitForTimeout(500);
  }

  return false;
}

function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function downloadJson(response, filename, data) {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseMailboxExportText(text) {
  const records = [];
  const lines = String(text || "").split(/\r?\n/);

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split("----");
    const [email, mailbox_password, mailbox_client_id, mailbox_refresh_token] = parts;
    const mailbox_group = parts[5] || parts[4] || "默认分组";
    if (!email || !email.includes("@") || !mailbox_client_id || !mailbox_refresh_token) continue;

    records.push({
      email,
      type: "codex",
      expired: "",
      mailbox_password: mailbox_password || "",
      mailbox_client_id,
      mailbox_refresh_token,
      mailbox_group,
      mailbox_source: "mailbox-export-text",
      mailbox_line: lineIndex + 1,
    });
  }

  if (records.length === 0) throw new Error("no valid mailbox export rows found");
  return records;
}

function parseCredentialRecords(payload) {
  if (typeof payload !== "string") return payload;

  const text = payload.trim();
  if (!text) throw new Error("empty credential input");
  try {
    return JSON.parse(text);
  } catch {
    return parseMailboxExportText(text);
  }
}

function importCredentials(records, options = {}) {
  const appendNew = options.appendNew !== false;
  const dryRun = options.dryRun === true;
  const parsed = parseCredentialRecords(records);
  const incoming = Array.isArray(parsed) ? parsed : [parsed];
  const clean = incoming.filter((item) => item && typeof item === "object" && item.email);
  if (clean.length === 0) throw new Error("no valid credential records found");

  const accounts = readAccounts();
  const byEmail = new Map(accounts.map((account, index) => [String(account.email).toLowerCase(), { account, index }]));
  const updated = [];
  const appended = [];
  const skipped = [];

  for (const item of clean) {
    const key = String(item.email).toLowerCase();
    const hit = byEmail.get(key);
    if (!hit) {
      if (appendNew) {
        accounts.push(item);
        byEmail.set(key, { account: item, index: accounts.length - 1 });
        appended.push({ index: accounts.length, email: item.email });
      } else {
        skipped.push({ email: item.email, reason: "email not found in current accounts" });
      }
      continue;
    }

    accounts[hit.index] = { ...hit.account, ...item };
    updated.push({ index: hit.index + 1, email: item.email });
  }

  if (!dryRun && (updated.length > 0 || appended.length > 0)) writeAccounts(accounts);
  return { updated, appended, skipped, backupPath, dryRun };
}

function readLogTail(filePath, maxChars = 12000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxChars);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (error) {
    return `读取日志失败：${error.message}`;
  }
}

function parseIndexesParam(value, accountsLength) {
  const seen = new Set();
  for (const raw of String(value || "").split(",")) {
    const index = Number(raw.trim()) - 1;
    if (Number.isInteger(index) && index >= 0 && index < accountsLength) {
      seen.add(index);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

async function exchangeAuthCode(code, verifier) {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", CLIENT_ID);
  params.set("redirect_uri", REDIRECT_URI);
  params.set("code_verifier", verifier);
  params.set("code", code);

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token exchange failed: ${response.status} ${text.slice(0, 160)}`);
  }

  return JSON.parse(text);
}

async function beginLogin(index) {
  const accounts = readAccounts();
  const account = accounts[index];
  if (!account) throw new Error("account index is out of range");
  if (!playwright) playwright = loadPlaywright();

  const existing = [...sessions.values()].find((session) => session.index === index);
  if (existing) return sessionView(existing);

  const pkce = makePkce();
  const browser = await playwright.chromium.launch({
    channel: "chrome",
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1120, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let callbackUrl = "";

  page.on("framenavigated", (frame) => {
    const url = frame.url();
    if (url.startsWith(REDIRECT_URI)) callbackUrl = url;
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(REDIRECT_URI)) callbackUrl = url;
  });

  try {
    await page.goto(authUrl(pkce), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first().fill(account.email);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    let readyForCode = await hasCodeInput(page, 8000);
    if (!readyForCode) {
      try {
        await page.getByRole("button", { name: /使用一次性验证码登录|one-time|code/i }).click({ timeout: 15000 });
      } catch (error) {
        readyForCode = await hasCodeInput(page, 3000);
        if (!readyForCode) throw error;
      }
      await page.waitForTimeout(2500);
      readyForCode = await hasCodeInput(page, 10000);
    }

    const body = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const abnormalReason = abnormalAccountReason(body);
    if (!readyForCode || abnormalReason) {
      const error = new Error(abnormalReason || `failed to open OTP page: ${page.url()} ${body.slice(0, 120)}`);
      if (abnormalReason) error.blockAutoRefresh = true;
      throw error;
    }
  } catch (error) {
    try {
      const screenshotPath = path.join(path.dirname(ACCOUNTS_PATH), `error_login_${index + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      console.error(`[beginLogin 错误] 账号 #${index + 1} 登录初始化失败，已截图保存至: ${screenshotPath}`);
    } catch (e) {
      // Ignore screenshot errors inside the catch handler
    }
    await browser.close().catch(() => {});
    throw error;
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    index,
    email: account.email,
    browser,
    page,
    pkce,
    createdAt: Date.now(),
    getCallbackUrl: () => callbackUrl,
  };
  sessions.set(id, session);
  return sessionView(session);
}

function sessionView(session) {
  return {
    id: session.id,
    index: session.index + 1,
    email: session.email,
    ageSeconds: Math.round((Date.now() - session.createdAt) / 1000),
  };
}

async function submitOtp(sessionId, otp, onProgress = () => {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");
  if (!/^\d{6}$/.test(String(otp))) throw new Error("OTP must be six digits");

  const { page, pkce } = session;
  onProgress("正在填写验证码。");
  await codeInputLocator(page).fill(String(otp));
  await page.keyboard.press("Enter");
  onProgress("验证码已提交到 OpenAI 页面，等待页面响应。");
  await page.waitForTimeout(2500);

  try {
    onProgress("检查是否需要授权确认。");
    const consentButton = page.getByRole("button", { name: /继续|Continue|Allow|Authorize|授权|同意|允许/i });
    if (await consentButton.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await consentButton.first().click({ timeout: 5000 });
    } else {
      const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();
      if (!(await submitButton.isVisible({ timeout: 1000 }).catch(() => false))) {
        throw new Error("consent button not visible");
      }
      await submitButton.click({ timeout: 5000 });
    }
    onProgress("已点击授权确认，等待回调。");
    await page.waitForTimeout(2500);
  } catch {
    onProgress("未出现授权确认按钮，继续等待回调。");
  }

  const deadline = Date.now() + 45000;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const current = session.getCallbackUrl() || page.url();
    if (current.startsWith(REDIRECT_URI)) {
      onProgress("已收到 OAuth 回调，正在校验 state。");
      const callback = new URL(current);
      if (callback.searchParams.get("state") !== pkce.state) {
        throw new Error("callback state mismatch");
      }

      const code = callback.searchParams.get("code");
      if (!code) throw new Error("callback is missing code");
      onProgress("正在交换 token。");
      const token = await exchangeAuthCode(code, pkce.verifier);
      const accounts = readAccounts();
      const account = accounts[session.index];
      account.id_token = token.id_token || account.id_token;
      account.access_token = token.access_token || account.access_token;
      account.refresh_token = token.refresh_token || account.refresh_token;
      const now = new Date();
      account.last_refresh = formatLocalDate(now);
      account.expired = formatLocalDate(new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000));
      writeAccounts(accounts);
      appendProgress(session.email, account.expired);
      onProgress("凭证已写回账号 JSON。");
      await closeSession(sessionId);
      return {
        index: session.index + 1,
        email: session.email,
        expired: account.expired,
        backupPath,
      };
    }

    const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (/代码不正确|incorrect|invalid code/i.test(body)) {
      throw new Error("OTP was rejected by the login page");
    }
    const abnormalReason = abnormalAccountReason(body);
    if (abnormalReason) {
      const error = new Error(`${abnormalReason} at ${page.url()}`);
      error.blockAutoRefresh = true;
      throw error;
    }

    if (Date.now() - lastProgress > 5000) {
      lastProgress = Date.now();
      onProgress(`仍在等待 OAuth 回调，当前页面：${page.url()}`);
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(`no callback after OTP submit; current page is ${page.url()}`);
}

function jobView(job) {
  return {
    id: job.id,
    status: job.status,
    index: job.index,
    email: job.email,
    result: job.result || null,
    error: job.error || "",
    logs: job.logs.slice(-80),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function addJobLog(job, message) {
  job.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  job.updatedAt = Date.now();
}

function startSubmitJob(sessionId, otp) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "running",
    index: session.index + 1,
    email: session.email,
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  addJobLog(job, `开始提交 #${job.index} ${job.email} 的验证码。`);

  submitOtp(sessionId, otp, (message) => addJobLog(job, message))
    .then((result) => {
      job.status = "done";
      job.result = result;
      addJobLog(job, `刷新成功，到期时间：${result.expired}`);
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.message;
      addJobLog(job, `失败：${error.message}`);
      if (shouldBlockAutoRefresh(error)) {
        blockAutoRefreshAccount(session.index, error.message);
        addJobLog(job, `已标记为异常账号，并从自动刷新队列移除。`);
      }
    });

  return jobView(job);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.browser.close().catch(() => {});
  return true;
}

function appendProgress(email, expired) {
  const progressPath = path.join(process.cwd(), "progress.md");
  const lines = [
    "",
    "## 2026-06-21 - Task: Refresh Codex OAuth account through WebUI",
    "### What was done",
    `- Refreshed one Codex account through the local WebUI: ${email}.`,
    "",
    "### Testing",
    "- Verified the OAuth callback, exchanged the authorization code, and wrote updated token fields back to the account JSON.",
    "",
    "### Notes",
    "- `scripts/codex-oauth-webui.mjs`: local WebUI refresh controller used for this refresh.",
    `- \`${path.basename(ACCOUNTS_PATH)}\`: updated only after successful OAuth completion.`,
    `- Rollback: restore from ${backupPath}.`,
    "",
  ];
  fs.appendFileSync(progressPath, lines.join("\n"), "utf8");
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex 授权刷新</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --text: #18202f;
      --muted: #687386;
      --ok: #16754a;
      --warn: #9a5b00;
      --bad: #b42318;
      --accent: #235fe3;
      --accent-soft: #e9efff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0; }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 30%) minmax(1180px, 1fr);
      min-height: calc(100vh - 56px);
      align-items: start;
      min-width: 1500px;
    }
    .left, .right { min-width: 0; }
    .left { position: sticky; top: 56px; height: calc(100vh - 56px); overflow: hidden; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    input, select {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
      background: #fff;
      min-width: 0;
    }
    button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .table { overflow: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: middle; }
    th { position: sticky; top: 0; background: #fbfcfe; color: var(--muted); font-size: 12px; font-weight: 600; z-index: 1; }
    td.email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr.selected { background: var(--accent-soft); }
    .badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
    .badge.ok { color: var(--ok); border-color: #b9e5cf; background: #eefaf3; }
    .badge.warn { color: var(--warn); border-color: #f1d194; background: #fff8e8; }
    .badge.run { color: var(--accent); border-color: #bfd0ff; background: var(--accent-soft); }
    .right { display: grid; grid-template-rows: auto auto auto auto auto; gap: 12px; padding: 14px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric strong { display: block; font-size: 22px; line-height: 1.2; }
    .metric span { color: var(--muted); font-size: 12px; }
    .work h2 { margin: 0 0 10px; font-size: 15px; }
    .sectiontitle { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
    .workgrid { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
    .quickgrid { display: grid; grid-template-columns: repeat(4, minmax(0, auto)); justify-content: start; gap: 8px; margin: 8px 0 12px; }
    .queuebar { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
    .queuebar strong { display: block; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queuebar span { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .switchline { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .switchline input { width: 16px; height: 16px; padding: 0; }
    .codebar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .framewrap { height: 900px; min-height: 900px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .framewrap.collapsed { display: none; }
    .codeframe { width: 1440px; min-width: 1440px; height: 1000px; min-height: 1000px; border: 0; transform: scale(var(--code-scale, 1)); transform-origin: 0 0; background: #fff; }
    .toolgrid { display: grid; grid-template-columns: repeat(3, minmax(0, auto)); justify-content: start; gap: 8px; }
    .hiddenfile { display: none; }
    .field label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
    .field input { width: 100%; font-size: 18px; letter-spacing: 0; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .log {
      overflow: auto;
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      background: #111827;
      color: #e5e7eb;
      border-radius: 8px;
      padding: 12px;
      min-height: 320px;
      max-height: 520px;
    }
    .muted { color: var(--muted); }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; height: auto; }
      .left { position: static; height: 52vh; border-right: 0; border-bottom: 1px solid var(--line); }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workgrid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Codex 授权刷新</h1>
    <div class="actions">
      <button onclick="location.href='/credentials'" title="打开凭证管理页面">凭证管理</button>
      <button id="reloadBtn" title="刷新账号列表">刷新列表</button>
      <button id="closeBtn" title="关闭当前会话">关闭会话</button>
    </div>
  </header>
  <main>
    <section class="left">
      <div class="toolbar">
        <input id="filterInput" placeholder="搜索邮箱或序号">
        <select id="statusFilter">
          <option value="pending">自动待刷新</option>
          <option value="all">全部</option>
          <option value="refreshed">已刷新</option>
        </select>
        <button id="startBtn" class="primary">打开验证码页</button>
      </div>
      <div class="table">
        <table>
          <thead>
            <tr>
              <th style="width: 56px;">#</th>
              <th>邮箱</th>
              <th style="width: 120px;">状态</th>
              <th style="width: 148px;">到期时间</th>
            </tr>
          </thead>
          <tbody id="accountRows"></tbody>
        </table>
      </div>
    </section>
    <section class="right">
      <div class="summary panel">
        <div class="metric"><strong id="totalCount">0</strong><span>账号总数</span></div>
        <div class="metric"><strong id="pendingCount">0</strong><span>自动待刷新</span></div>
        <div class="metric"><strong id="doneCount">0</strong><span>已刷新</span></div>
        <div class="metric"><strong id="sessionCount">0</strong><span>打开会话</span></div>
      </div>
      <div class="panel">
        <h2 class="sectiontitle">队列工作台</h2>
        <div class="queuebar">
          <div>
            <strong id="queueCurrent">未选择账号</strong>
            <span id="queueNext">下一个：暂无</span>
          </div>
          <div class="actions">
            <button id="prevPendingBtn" title="选择上一个自动待刷新账号">上一个</button>
            <button id="nextPendingBtn" title="选择下一个自动待刷新账号">下一个</button>
          </div>
        </div>
        <label class="switchline">
          <input id="autoNextInput" type="checkbox" checked>
          <span>提交成功后自动选中下一个自动待刷新账号</span>
        </label>
      </div>
      <div class="panel">
        <h2 class="sectiontitle">全自动批量刷新工作台</h2>
        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px;">
          <button id="startAutoBtn" class="primary" title="一键全自动批量刷新所有自动待刷新账号">一键全自动刷新</button>
          <button id="stopAutoBtn" style="color: var(--bad); border-color: #fca5a5;" title="停止全自动批量刷新" disabled>停止自动刷新</button>
        </div>
        <div id="autoStatusText" style="font-size: 13px; color: var(--muted); margin-bottom: 4px;">当前状态：空闲</div>
        <div id="autoProgressWrap" style="display: none; height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 6px;">
          <div id="autoProgressBar" style="width: 0%; height: 100%; background: var(--accent); transition: width 0.3s;"></div>
        </div>
      </div>
      <div class="work panel">
        <h2 id="selectedTitle">未选择账号</h2>
        <div class="quickgrid">
          <button id="singleAutoBtn" class="primary" style="background: var(--ok); border-color: var(--ok);" title="全自动接码并完成刷新当前账号">自动接码刷新</button>
          <button id="oneClickBtn" class="primary" title="复制邮箱并触发验证码">一键开始</button>
          <button id="copyEmailBtn" title="复制当前选中的邮箱">复制邮箱</button>
          <button id="codeSiteBtn" title="打开取码网站">打开取码网站</button>
          <button id="copyOpenBtn" title="复制邮箱并打开取码网站">复制并打开</button>
          <button id="mailDiagBtn" title="检查当前账号邮箱最近邮件">检查邮箱邮件</button>
          <button id="showLogsBtn" title="显示服务日志和报错">查看报错</button>
        </div>
        <div class="workgrid">
          <div class="field">
            <label for="otpInput">验证码</label>
            <input id="otpInput" inputmode="numeric" maxlength="6" placeholder="6 位数字">
          </div>
          <button id="submitBtn" class="primary">提交验证码</button>
        </div>
        <p class="muted" id="sessionText">选中账号不会发送验证码；点“一键开始”或“打开验证码页”后才会发码。</p>
      </div>
      <div class="panel">
        <h2 class="sectiontitle">取码网站</h2>
        <div class="codebar">
          <button id="codeToggleBtn" title="隐藏或显示内嵌取码网站">隐藏取码网站</button>
          <button id="codeCopyEmailBtn" title="复制当前选中账号邮箱">复制当前邮箱</button>
          <button id="codeReloadBtn" title="刷新内嵌取码网站">刷新取码网站</button>
          <button id="codeFitBtn" title="按当前容器宽度自适应">自适应宽度</button>
          <button id="codeZoomOutBtn" title="缩小取码网站">缩小</button>
          <button id="codeZoomResetBtn" title="恢复默认大小">原始大小</button>
          <button id="codeZoomInBtn" title="放大取码网站">放大</button>
        </div>
        <div id="codeFrameWrap" class="framewrap" style="--code-scale: 0.9;">
          <iframe id="codeSiteFrame" class="codeframe" src="${CODE_SITE_URL}" title="取码网站"></iframe>
        </div>
        <p class="muted">看不清邮箱时先点“复制当前邮箱”，也可以用“放大/缩小”调整显示。</p>
      </div>
      <div class="log" id="log"></div>
    </section>
  </main>
  <script>
    let accounts = [];
    let selectedIndex = null;
    let currentSession = null;
    let activeSessions = [];
    let autoNext = true;
    let codeScale = 0.9;
    let codeAutoFit = true;
    let codeSiteHidden = false;
    let knownJobLogs = new Set();
    const codeSiteUrl = "${CODE_SITE_URL}";

    const $ = (id) => document.getElementById(id);
    const log = (line) => {
      const box = $("log");
      box.textContent = "[" + new Date().toLocaleTimeString() + "] " + line + "\\n" + box.textContent;
    };

    async function api(path, body) {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function render() {
      const filter = $("filterInput").value.trim().toLowerCase();
      const status = $("statusFilter").value;
      const rows = $("accountRows");
      rows.innerHTML = "";

      const total = accounts.length;
      const done = accounts.filter((a) => a.refreshed).length;
      const pending = pendingAccounts();
      const active = accounts.filter((a) => a.activeSession).length;
      $("totalCount").textContent = total;
      $("doneCount").textContent = done;
      $("pendingCount").textContent = pending.length;
      $("sessionCount").textContent = active;

      for (const account of accounts) {
        if (status === "pending" && !account.autoRefreshable) continue;
        if (status === "refreshed" && !account.refreshed) continue;
        if (filter && !(String(account.index).includes(filter) || account.email.toLowerCase().includes(filter))) continue;

        const tr = document.createElement("tr");
        if (account.index === selectedIndex) tr.className = "selected";
        tr.onclick = () => selectAccount(account.index);
        const badgeClass = account.activeSession ? "run" : account.autoRefreshBlocked ? "warn" : !account.mailboxReady ? "warn" : account.expiredNow ? "warn" : "ok";
        const badgeText = account.activeSession ? "等待验证码" : account.autoRefreshBlocked ? "异常" : !account.mailboxReady ? "邮箱不可用" : account.expiredNow ? "已过期" : "有效";
        tr.innerHTML = "<td>" + account.index + "</td><td class='email' title='" + account.email + "'>" + account.email + "</td><td><span class='badge " + badgeClass + "'>" + badgeText + "</span></td><td>" + account.expired + "</td>";
        rows.appendChild(tr);
      }
      updateQueuePanel();
      updateSelectedPanel();
    }

    function sessionForIndex(index) {
      return activeSessions.find((session) => session.index === index) || null;
    }

    function statusText(account) {
      if (!account) return "选中账号不会发送验证码；点“一键开始”或“打开验证码页”后才会发码。";
      if (sessionForIndex(account.index)) return "状态：验证码页已打开，等待输入该账号验证码。";
      if (account.autoRefreshBlocked) return "状态：异常账号，已从自动刷新队列移除。" + (account.autoRefreshBlockReason ? " 原因：" + account.autoRefreshBlockReason : "");
      if (!account.mailboxReady) return "状态：缺少可用邮箱授权，不能进入自动刷新队列。";
      if (account.refreshed && !account.expiredNow) return "状态：已刷新且有效。";
      if (account.expiredNow) return "状态：未刷新或已过期。";
      return "状态：凭证仍有效。";
    }

    function updateSelectedPanel() {
      if (selectedIndex) currentSession = sessionForIndex(selectedIndex);
      const selected = selectedAccount();
      $("selectedTitle").textContent = selected ? "#" + selected.index + " " + selected.email : "未选择账号";
      $("sessionText").textContent = statusText(selected);
    }

    function selectAccount(index) {
      selectedIndex = index;
      currentSession = sessionForIndex(index);
      render();
    }

    function pendingAccounts() {
      return accounts.filter((account) => account.autoRefreshable);
    }

    function currentPendingPosition() {
      const pending = pendingAccounts();
      const pos = pending.findIndex((account) => account.index === selectedIndex);
      return { pending, pos };
    }

    function nextPendingIndex(direction = 1) {
      const { pending, pos } = currentPendingPosition();
      if (pending.length === 0) return null;
      if (pos === -1) return pending[0].index;
      const nextPos = (pos + direction + pending.length) % pending.length;
      return pending[nextPos].index;
    }

    function updateQueuePanel() {
      const account = selectedAccount();
      const nextIndex = nextPendingIndex(1);
      const nextAccount = accounts.find((x) => x.index === nextIndex);
      $("queueCurrent").textContent = account ? ("当前：#" + account.index + " " + account.email) : "未选择账号";
      $("queueNext").textContent = nextAccount && account && nextAccount.index !== account.index
        ? ("下一个：#" + nextAccount.index + " " + nextAccount.email)
        : "下一个：暂无";
    }

    async function loadAccounts() {
      const data = await api("/api/accounts");
      accounts = data.accounts;
      activeSessions = data.sessions || [];
      if (currentSession && !activeSessions.some((session) => session.id === currentSession.id)) currentSession = null;
      if (selectedIndex && !accounts.some((a) => a.index === selectedIndex)) selectedIndex = null;
      if (!selectedIndex) {
        const firstPending = pendingAccounts()[0];
        if (firstPending) selectedIndex = firstPending.index;
      }
      if (selectedIndex) currentSession = sessionForIndex(selectedIndex);
      render();
    }

    function selectedAccount() {
      return accounts.find((x) => x.index === selectedIndex);
    }

    async function copySelectedEmail() {
      const account = selectedAccount();
      if (!account) return log("请先选择一个账号。");
      try {
        await navigator.clipboard.writeText(account.email);
        log("已复制邮箱：" + account.email);
      } catch (error) {
        log("复制失败，请手动复制：" + account.email);
      }
    }

    function openCodeSite() {
      if (!codeSiteUrl) return log("未配置取码网站。请设置 CODE_SITE_URL 或 --code-site-url。");
      window.open(codeSiteUrl, "_blank", "noopener,noreferrer");
      log("已打开取码网站：" + codeSiteUrl);
    }

    function reloadCodeSite() {
      if (!codeSiteUrl) return log("未配置取码网站。请设置 CODE_SITE_URL 或 --code-site-url。");
      if (codeSiteHidden) toggleCodeSite(false);
      $("codeSiteFrame").src = codeSiteUrl + (codeSiteUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
      log("已刷新内嵌取码网站。");
    }

    function setCodeZoom(nextScale) {
      if (codeSiteHidden) toggleCodeSite(false);
      codeAutoFit = false;
      codeScale = Math.max(0.75, Math.min(1.5, nextScale));
      $("codeFrameWrap").style.setProperty("--code-scale", String(codeScale));
      log("取码网站缩放：" + Math.round(codeScale * 100) + "%");
    }

    function fitCodeSiteWidth() {
      const wrap = $("codeFrameWrap");
      if (codeSiteHidden) return;
      const innerWidth = Math.max(320, wrap.clientWidth - 8);
      codeScale = Math.max(0.55, Math.min(1, innerWidth / 1440));
      codeAutoFit = true;
      wrap.style.setProperty("--code-scale", String(codeScale));
      log("取码网站已自适应宽度：" + Math.round(codeScale * 100) + "%");
    }

    function toggleCodeSite(forceHidden) {
      codeSiteHidden = typeof forceHidden === "boolean" ? forceHidden : !codeSiteHidden;
      $("codeFrameWrap").classList.toggle("collapsed", codeSiteHidden);
      $("codeToggleBtn").textContent = codeSiteHidden ? "显示取码网站" : "隐藏取码网站";
      log(codeSiteHidden ? "已隐藏内嵌取码网站。" : "已显示内嵌取码网站。");
      if (!codeSiteHidden && codeAutoFit) setTimeout(fitCodeSiteWidth, 0);
    }

    async function copyAndOpenCodeSite() {
      await copySelectedEmail();
      openCodeSite();
    }

    async function oneClickStart() {
      if (!selectedIndex) return log("请先选择一个账号。");
      await copySelectedEmail();
      log("正在触发 OpenAI 验证码邮件，请稍等。");
      await startOtp();
    }

    function movePending(direction) {
      const index = nextPendingIndex(direction);
      if (!index) return log("没有自动待刷新账号。");
      selectAccount(index);
      const account = selectedAccount();
      log("已选择：#" + account.index + " " + account.email);
    }

    async function startOtp() {
      if (!selectedIndex) return log("请先选择一个账号。");
      $("startBtn").disabled = true;
      try {
        const data = await api("/api/start", { index: selectedIndex });
        currentSession = data.session;
        selectedIndex = currentSession.index;
        $("sessionText").textContent = "当前会话：#" + currentSession.index + " " + currentSession.email;
        log("已打开验证码页：#" + currentSession.index + " " + currentSession.email);
        log("已安排 25 秒后自动检查邮箱新邮件。");
        setTimeout(() => {
          if (selectedIndex === currentSession.index) checkMailboxMessages(true);
        }, 25000);
        await loadAccounts();
      } catch (error) {
        log("打开失败：" + error.message);
      } finally {
        $("startBtn").disabled = false;
      }
    }

    async function submitOtp() {
      const otp = $("otpInput").value.trim();
      const session = sessionForIndex(selectedIndex) || currentSession;
      if (!session) return log("当前选中账号没有打开中的验证码会话。");
      if (!/^\\d{6}$/.test(otp)) return log("请输入 6 位数字验证码。");
      $("submitBtn").disabled = true;
      try {
        const data = await api("/api/submit-job", { sessionId: session.id, otp });
        log("已创建后台任务：#" + data.job.index + " " + data.job.email);
        $("otpInput").value = "";
      } catch (error) {
        log("提交失败：" + error.message);
      } finally {
        $("submitBtn").disabled = false;
      }
    }

    async function pollJobs() {
      try {
        const data = await api("/api/jobs");
        for (const job of data.jobs) {
          for (const line of job.logs || []) {
            const key = job.id + ":" + line;
            if (!knownJobLogs.has(key)) {
              knownJobLogs.add(key);
              log("任务 #" + job.index + " " + line);
            }
          }
          if (job.status === "done" && !knownJobLogs.has(job.id + ":done")) {
            knownJobLogs.add(job.id + ":done");
            await loadAccounts();
            if (autoNext) {
              const nextIndex = nextPendingIndex(1);
              if (nextIndex) {
                selectAccount(nextIndex);
                const next = selectedAccount();
                $("sessionText").textContent = "刷新完成，已切到下一个自动待刷新账号。";
                log("已切到下一个：#" + next.index + " " + next.email);
              }
            }
          }
          if (job.status === "failed" && !knownJobLogs.has(job.id + ":failed")) {
            knownJobLogs.add(job.id + ":failed");
            log("任务失败：#" + job.index + " " + (job.error || "未知错误"));
          }
        }
      } catch (error) {
        // Avoid noisy polling logs; manual 查看报错 can show server logs.
      }
    }

    async function closeSession() {
      const session = sessionForIndex(selectedIndex) || currentSession;
      if (!session) return log("当前选中账号没有打开中的验证码会话。");
      try {
        await api("/api/close", { sessionId: session.id });
        log("已关闭会话：#" + session.index + " " + session.email);
        currentSession = null;
        $("sessionText").textContent = "会话已关闭。";
        await loadAccounts();
      } catch (error) {
        log("关闭失败：" + error.message);
      }
    }

    async function showServerLogs() {
      try {
        const data = await api("/api/logs");
        log("服务输出：\\n" + (data.out || "无输出"));
        log("服务报错：\\n" + (data.err || "无报错"));
      } catch (error) {
        log("读取服务日志失败：" + error.message);
      }
    }

    async function checkMailboxMessages(autoCheck = false) {
      const account = selectedAccount();
      if (!account) return log("请先选择一个账号。");
      try {
        log((autoCheck ? "自动检查" : "正在检查") + "邮箱最近邮件：#" + account.index + " " + account.email);
        const data = await api("/api/mail-diagnostics?index=" + encodeURIComponent(account.index));
        const cutoff = Date.now() - 10 * 60 * 1000;
        let recentRelevant = 0;
        let folderCount = 0;
        log("邮箱授权状态：正常。最近邮件如下（验证码数字会打码）：");
        for (const folder of data.folders) {
          folderCount++;
          if (!folder.ok) {
            log(folder.label + "：读取失败 " + (folder.error || folder.status));
            continue;
          }
          if (!folder.items.length) {
            log(folder.label + "：没有邮件。");
            continue;
          }
          const relevant = folder.items.filter((item) => item.relevant);
          recentRelevant += relevant.filter((item) => Date.parse(item.received) >= cutoff).length;
          log(folder.label + "：最近 " + folder.items.length + " 封，疑似 OpenAI/验证码邮件 " + relevant.length + " 封。");
          for (const item of folder.items.slice(0, 3)) {
            log("  " + folder.label + " | " + (item.received || "无时间") + " | " + (item.relevant ? "相关" : "普通") + " | " + item.subjectPreview);
          }
        }
        log("本次共检查 " + folderCount + " 个邮箱文件夹；10 分钟内新 OpenAI/验证码邮件：" + recentRelevant + " 封。");
        if (recentRelevant === 0) log("未发现新验证码邮件。可能是邮件仍在延迟、OpenAI 未投递，或该邮箱被投递侧拦截。");
      } catch (error) {
        log("检查邮箱邮件失败：" + error.message);
      }
    }

    let lastAutoTaskId = null;
    let lastAutoReloadedTaskId = null;
    const knownAutoLogs = new Set();

    async function pollAutoRefresh() {
      try {
        const data = await api("/api/auto-refresh/status");
        const state = data.state;
        if (!state) return;

        const startBtn = $("startAutoBtn");
        const stopBtn = $("stopAutoBtn");
        const statusText = $("autoStatusText");
        const progressWrap = $("autoProgressWrap");
        const progressBar = $("autoProgressBar");

        if (state.taskId !== lastAutoTaskId) {
          lastAutoTaskId = state.taskId;
          knownAutoLogs.clear();
        }

        if (state.logs && state.logs.length > 0) {
          for (const line of state.logs) {
            if (!knownAutoLogs.has(line)) {
              knownAutoLogs.add(line);
              log(line);
            }
          }
        }

        if (state.status === "running") {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          progressWrap.style.display = "block";
          statusText.textContent = "当前状态：正在全自动批量刷新（已处理 " + state.processed + "/" + state.total + "，成功: " + state.successCount + "，失败: " + state.failedCount + "）";
          const pct = state.total > 0 ? (state.processed / state.total) * 100 : 0;
          progressBar.style.width = pct + "%";
        } else {
          startBtn.disabled = false;
          stopBtn.disabled = true;
          if (state.status === "done") {
            statusText.textContent = "当前状态：批量刷新完成。成功: " + state.successCount + "，失败: " + state.failedCount;
            progressBar.style.width = "100%";
            if (state.taskId && state.taskId !== lastAutoReloadedTaskId) {
              lastAutoReloadedTaskId = state.taskId;
              await loadAccounts();
              log("自动刷新完成，已重新加载账号状态。");
            }
          } else if (state.status === "stopped") {
            statusText.textContent = "当前状态：已手动停止。成功: " + state.successCount + "，失败: " + state.failedCount;
          } else {
            statusText.textContent = "当前状态：空闲";
            progressWrap.style.display = "none";
            progressBar.style.width = "0%";
          }
        }
      } catch (error) {
        // Quietly ignore polling errors.
      }
    }

    async function startAutoRefresh() {
      try {
        const data = await api("/api/accounts");
        accounts = data.accounts;
        render();

        const pending = accounts.filter((a) => a.autoRefreshable);
        if (pending.length === 0) {
          log("没有自动待刷新的账号。");
          return;
        }

        const indexes = pending.map((a) => a.index - 1);
        log("开始全自动批量刷新，计划处理 " + indexes.length + " 个账号。");
        await api("/api/auto-refresh/start", { indexes });
      } catch (error) {
        log("启动自动批量刷新失败：" + error.message);
      }
    }

    async function stopAutoRefresh() {
      try {
        log("正在请求停止全自动批量刷新...");
        await api("/api/auto-refresh/stop");
      } catch (error) {
        log("停止批量刷新失败：" + error.message);
      }
    }

    async function startSingleAutoRefresh() {
      if (!selectedIndex) return log("请先选择一个账号。");
      const account = selectedAccount();
      if (!account) return log("无法获取当前选中账号的信息。");
      if (!account.mailboxReady) return log("当前账号缺少可用邮箱授权，不能自动接码刷新。");
      if (!account.expiredNow) return log("当前账号凭证仍有效，不进入自动刷新队列。");
      try {
        log("开始自动接码刷新当前选中账号 #" + account.index + " (" + account.email + ")...");
        await api("/api/auto-refresh/start", { indexes: [account.index - 1] });
      } catch (error) {
        log("自动接码刷新账号失败：" + error.message);
      }
    }

    $("filterInput").oninput = render;
    $("statusFilter").onchange = render;
    $("reloadBtn").onclick = loadAccounts;
    $("startBtn").onclick = startOtp;
    $("submitBtn").onclick = submitOtp;
    $("closeBtn").onclick = closeSession;
    $("copyEmailBtn").onclick = copySelectedEmail;
    $("codeSiteBtn").onclick = openCodeSite;
    $("copyOpenBtn").onclick = copyAndOpenCodeSite;
    $("oneClickBtn").onclick = oneClickStart;
    $("mailDiagBtn").onclick = checkMailboxMessages;
    $("showLogsBtn").onclick = showServerLogs;
    $("codeToggleBtn").onclick = () => toggleCodeSite();
    $("codeCopyEmailBtn").onclick = copySelectedEmail;
    $("codeReloadBtn").onclick = reloadCodeSite;
    $("codeFitBtn").onclick = fitCodeSiteWidth;
    $("codeZoomOutBtn").onclick = () => setCodeZoom(codeScale - 0.1);
    $("codeZoomResetBtn").onclick = fitCodeSiteWidth;
    $("codeZoomInBtn").onclick = () => setCodeZoom(codeScale + 0.1);
    $("prevPendingBtn").onclick = () => movePending(-1);
    $("nextPendingBtn").onclick = () => movePending(1);
    $("startAutoBtn").onclick = startAutoRefresh;
    $("stopAutoBtn").onclick = stopAutoRefresh;
    $("singleAutoBtn").onclick = startSingleAutoRefresh;
    $("autoNextInput").onchange = (event) => {
      autoNext = event.target.checked;
      log(autoNext ? "已开启自动切到下一个。" : "已关闭自动切到下一个。");
    };
    $("otpInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitOtp();
    });

    window.addEventListener("resize", () => {
      if (codeAutoFit) fitCodeSiteWidth();
    });
    loadAccounts().then(() => {
      fitCodeSiteWidth();
      log("已就绪。");
    });
    setInterval(pollJobs, 1000);
    setInterval(pollAutoRefresh, 1000);
  </script>
</body>
</html>`;
}

function credentialsHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>凭证管理</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --text: #18202f;
      --muted: #687386;
      --ok: #16754a;
      --warn: #9a5b00;
      --accent: #235fe3;
      --accent-soft: #e9efff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
    header { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0; }
    main { display: grid; grid-template-rows: auto 1fr auto; gap: 12px; height: calc(100vh - 56px); padding: 14px; min-height: 560px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
    .toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto auto auto auto; gap: 8px; align-items: center; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    input, select, button { height: 34px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); padding: 0 10px; font: inherit; min-width: 0; }
    button { cursor: pointer; white-space: nowrap; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .table { overflow: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: middle; }
    th { position: sticky; top: 0; background: #fbfcfe; color: var(--muted); font-size: 12px; font-weight: 600; z-index: 1; }
    td.email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr.selected { background: var(--accent-soft); }
    .badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
    .badge.ok { color: var(--ok); border-color: #b9e5cf; background: #eefaf3; }
    .badge.warn { color: var(--warn); border-color: #f1d194; background: #fff8e8; }
    .summary { color: var(--muted); font-size: 13px; }
    .hiddenfile { display: none; }
    .log { overflow: auto; min-height: 90px; max-height: 160px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; white-space: pre-wrap; background: #111827; color: #e5e7eb; border-radius: 8px; padding: 12px; }
    .modalbackdrop { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(15, 23, 42, .42); z-index: 20; }
    .modalbackdrop.open { display: flex; }
    .modal { width: min(760px, 100%); max-height: calc(100vh - 36px); overflow: auto; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); padding: 14px; }
    .modalhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .modalhead strong { font-size: 16px; }
    .modal textarea { width: 100%; min-height: 320px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; color: var(--text); }
    .modal textarea::placeholder { color: rgba(100, 116, 139, .55); }
    .modalnote { margin: 8px 0 12px; color: var(--muted); font-size: 12px; }
    .modalactions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    @media (max-width: 980px) {
      main { height: auto; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .actions { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>凭证管理</h1>
    <div class="actions">
      <button onclick="location.href='/'">返回刷新页</button>
      <button id="reloadBtn">刷新列表</button>
    </div>
  </header>
  <main>
    <section class="panel toolbar">
      <input id="filterInput" placeholder="搜索邮箱或序号">
      <select id="statusFilter">
        <option value="all">全部账号</option>
        <option value="valid">有效账号</option>
        <option value="expired">过期账号</option>
        <option value="refreshed">已刷新账号</option>
      </select>
      <button id="selectVisibleBtn">勾选当前列表</button>
      <button id="clearSelectedBtn">清空勾选</button>
      <button id="downloadSelectedBtn" class="primary">下载已勾选</button>
      <button id="downloadRefreshedBtn">下载全部已刷新</button>
      <div class="actions">
        <button id="importBtn">导入凭证</button>
        <button id="checkSelectedBtn">检查已勾选</button>
        <button id="checkAllBtn">检查全部</button>
      </div>
      <input id="importFileInput" class="hiddenfile" type="file" accept="application/json,.json,text/plain,.txt">
    </section>
    <div id="importModal" class="modalbackdrop" role="dialog" aria-modal="true" aria-labelledby="importModalTitle">
      <div class="modal">
        <div class="modalhead">
          <strong id="importModalTitle">导入凭证</strong>
          <button id="importCloseBtn" title="关闭导入窗口">关闭</button>
        </div>
        <textarea id="importTextInput" spellcheck="false" placeholder='[
  {
    "email": "user@example.com",
    "type": "codex",
    "id_token": "OpenAI_ID_TOKEN_HERE",
    "access_token": "OpenAI_ACCESS_TOKEN_HERE",
    "refresh_token": "OpenAI_REFRESH_TOKEN_HERE",
    "expired": "2026/7/1 3:13:46",
    "last_refresh": "2026/6/21 3:13:46",
    "mailbox_client_id": "MICROSOFT_CLIENT_ID_HERE",
    "mailbox_refresh_token": "MICROSOFT_MAILBOX_REFRESH_TOKEN_HERE",
    "mailbox_password": "MAILBOX_PASSWORD_OPTIONAL"
  }
]'></textarea>
        <div class="modalnote">可粘贴 JSON 对象、JSON 数组，或邮箱导出文本。已有邮箱会合并更新，新邮箱会新增为待刷新账号。</div>
        <div class="modalactions">
          <button id="importExampleBtn">填入示例</button>
          <button id="importChooseFileBtn">选择 JSON 文件</button>
          <button id="importClearBtn">清空输入</button>
          <button id="importTextBtn" class="primary">导入输入内容</button>
        </div>
      </div>
    </div>
    <section class="panel table">
      <table>
        <thead>
          <tr>
            <th style="width: 52px;"><input id="checkAllVisible" type="checkbox" title="勾选当前列表"></th>
            <th style="width: 64px;">#</th>
            <th>邮箱</th>
            <th style="width: 110px;">状态</th>
            <th style="width: 160px;">本地到期</th>
            <th style="width: 160px;">Token 到期</th>
          </tr>
        </thead>
        <tbody id="credentialRows"></tbody>
      </table>
    </section>
    <section class="panel">
      <div class="summary" id="summaryText">正在读取账号...</div>
      <div class="log" id="log"></div>
    </section>
  </main>
  <script>
    let accounts = [];
    const selected = new Set();
    const $ = (id) => document.getElementById(id);
    const log = (line) => {
      const box = $("log");
      box.textContent = "[" + new Date().toLocaleTimeString() + "] " + line + "\\n" + box.textContent;
    };

    async function api(path, body) {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    function visibleAccounts() {
      const filter = $("filterInput").value.trim().toLowerCase();
      const status = $("statusFilter").value;
      return accounts.filter((account) => {
        if (status === "valid" && account.expiredNow) return false;
        if (status === "expired" && !account.expiredNow) return false;
        if (status === "refreshed" && !account.refreshed) return false;
        if (filter && !(String(account.index).includes(filter) || account.email.toLowerCase().includes(filter))) return false;
        return true;
      });
    }

    function render() {
      const rows = $("credentialRows");
      rows.innerHTML = "";
      const visible = visibleAccounts();
      for (const account of visible) {
        const checked = selected.has(account.index);
        const tr = document.createElement("tr");
        if (checked) tr.className = "selected";
        const badgeClass = account.expiredNow ? "warn" : "ok";
        const badgeText = account.expiredNow ? "已过期" : "有效";
        tr.innerHTML = "<td><input class='rowcheck' type='checkbox' data-index='" + account.index + "'" + (checked ? " checked" : "") + "></td><td>" + account.index + "</td><td class='email' title='" + account.email + "'>" + account.email + "</td><td><span class='badge " + badgeClass + "'>" + badgeText + "</span></td><td>" + account.expired + "</td><td>" + (account.tokenExpiresAt || "未知") + "</td>";
        rows.appendChild(tr);
      }
      for (const input of document.querySelectorAll(".rowcheck")) {
        input.onchange = (event) => {
          const index = Number(event.target.dataset.index);
          if (event.target.checked) selected.add(index);
          else selected.delete(index);
          render();
        };
      }
      const valid = accounts.filter((a) => !a.expiredNow).length;
      const expired = accounts.length - valid;
      $("summaryText").textContent = "总数 " + accounts.length + "，有效 " + valid + "，过期 " + expired + "，已勾选 " + selected.size + "，当前列表 " + visible.length;
      $("checkAllVisible").checked = visible.length > 0 && visible.every((account) => selected.has(account.index));
    }

    async function loadAccounts() {
      const data = await api("/api/accounts");
      accounts = data.accounts;
      for (const index of [...selected]) {
        if (!accounts.some((account) => account.index === index)) selected.delete(index);
      }
      render();
    }

    function downloadUrl(url) {
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function selectedIndexes() {
      return [...selected].sort((a, b) => a - b);
    }

    function downloadSelected() {
      const indexes = selectedIndexes();
      if (indexes.length === 0) return log("请先勾选账号。");
      downloadUrl("/api/export?type=indexes&indexes=" + encodeURIComponent(indexes.join(",")));
      log("已开始下载已勾选账号：" + indexes.length + " 个。");
    }

    function downloadRefreshed() {
      downloadUrl("/api/export?type=refreshed");
      log("已开始下载全部已刷新账号。");
    }

    async function importRecords(records) {
      const data = await api("/api/import", { records });
      log("导入完成：更新 " + data.updated.length + " 个，新增 " + data.appended.length + " 个，跳过 " + data.skipped.length + " 个。");
      await loadAccounts();
      closeImportModal();
    }

    function openImportModal() {
      $("importModal").classList.add("open");
      $("importTextInput").focus();
    }

    function closeImportModal() {
      $("importModal").classList.remove("open");
    }

    function fillImportExample() {
      $("importTextInput").value = JSON.stringify([
        {
          email: "demo001@example.com",
          type: "codex",
          id_token: "DEMO_OPENAI_ID_TOKEN",
          access_token: "DEMO_OPENAI_ACCESS_TOKEN",
          refresh_token: "DEMO_OPENAI_REFRESH_TOKEN",
          expired: "2026/7/1 3:13:46",
          last_refresh: "2026/6/21 3:13:46",
          mailbox_client_id: "DEMO_MICROSOFT_CLIENT_ID",
          mailbox_refresh_token: "DEMO_MICROSOFT_MAILBOX_REFRESH_TOKEN",
          mailbox_password: "DEMO_MAILBOX_PASSWORD",
          mailbox_group: "默认分组"
        }
      ], null, 2);
      $("importTextInput").focus();
      log("已填入虚构示例，请替换为真实账号数据后再导入。");
    }

    async function importCredentialText() {
      const text = $("importTextInput").value.trim();
      if (!text) return log("请先粘贴 JSON/邮箱导出文本，或选择文件。");
      try {
        await importRecords(text);
      } catch (error) {
        log("导入失败：" + error.message);
      }
    }

    async function importCredentialFile(file) {
      if (!file) return;
      try {
        const text = await file.text();
        $("importTextInput").value = text;
        await importRecords(text);
      } catch (error) {
        log("导入失败：" + error.message);
      } finally {
        $("importFileInput").value = "";
      }
    }

    async function checkSelected() {
      const indexes = selectedIndexes();
      if (indexes.length === 0) return log("请先勾选账号。");
      try {
        const data = await api("/api/check?type=indexes&indexes=" + encodeURIComponent(indexes.join(",")));
        log("检查已勾选：有效 " + data.valid + " 个，已过期 " + data.expired + " 个，未知 " + data.unknown + " 个。");
      } catch (error) {
        log("检查失败：" + error.message);
      }
    }

    async function checkAll() {
      try {
        const data = await api("/api/check?type=all");
        log("检查全部：有效 " + data.valid + " 个，已过期 " + data.expired + " 个，未知 " + data.unknown + " 个。");
      } catch (error) {
        log("检查失败：" + error.message);
      }
    }

    function selectVisible() {
      for (const account of visibleAccounts()) selected.add(account.index);
      render();
    }

    $("reloadBtn").onclick = loadAccounts;
    $("filterInput").oninput = render;
    $("statusFilter").onchange = render;
    $("selectVisibleBtn").onclick = selectVisible;
    $("clearSelectedBtn").onclick = () => { selected.clear(); render(); };
    $("downloadSelectedBtn").onclick = downloadSelected;
    $("downloadRefreshedBtn").onclick = downloadRefreshed;
    $("importBtn").onclick = openImportModal;
    $("importCloseBtn").onclick = closeImportModal;
    $("importExampleBtn").onclick = fillImportExample;
    $("importChooseFileBtn").onclick = () => $("importFileInput").click();
    $("importClearBtn").onclick = () => { $("importTextInput").value = ""; $("importTextInput").focus(); };
    $("importTextBtn").onclick = importCredentialText;
    $("importModal").onclick = (event) => {
      if (event.target.id === "importModal") closeImportModal();
    };
    $("importFileInput").onchange = (event) => importCredentialFile(event.target.files[0]);
    $("checkSelectedBtn").onclick = checkSelected;
    $("checkAllBtn").onclick = checkAll;
    $("checkAllVisible").onchange = (event) => {
      for (const account of visibleAccounts()) {
        if (event.target.checked) selected.add(account.index);
        else selected.delete(account.index);
      }
      render();
    };

    loadAccounts().then(() => log("凭证管理已就绪。"));
  </script>
</body>
</html>`;
}

function cleanHtml(html) {
  if (!html) return "";
  let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/&amp;/g, "&");
  return text;
}

function extractVerificationCode(subject, content) {
  const subjectText = String(subject || "");
  const bodyText = cleanHtml(String(content || ""));
  const abnormalReason = abnormalAccountReason(`${subjectText}\n${bodyText}`);
  if (abnormalReason) {
    const error = new Error(abnormalReason);
    error.blockAutoRefresh = true;
    throw error;
  }
  const relevant = /登录代码|验证码|verification code|登入码|OpenAI|ChatGPT/i.test(subjectText) || /OpenAI|ChatGPT|verification code|验证码|登录代码/i.test(bodyText);
  if (!relevant) return "";
  const match = bodyText.match(/\b\d{6}\b/) || subjectText.match(/\b\d{6}\b/);
  return match ? match[0] : "";
}

async function fetchEmailCode(email, client_id, refresh_token, sentAfter = 0) {
  const cleanEmail = String(email || "").trim();
  
  if (client_id && refresh_token) {
    try {
      const params = new URLSearchParams();
      params.append("client_id", client_id);
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", refresh_token);
      
      const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
        method: "POST",
        body: params,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(`邮箱授权换取失败：${tokenJson.error || tokenRes.status}`);
      }
      if (tokenJson.access_token) {
        const folders = [
          { id: "Inbox", label: "收件箱" },
          { id: "JunkEmail", label: "垃圾邮件" },
          { id: "DeletedItems", label: "已删除" },
          { id: "Archive", label: "归档" },
          { id: "Clutter", label: "其他邮件" },
        ];

        for (const folder of folders) {
          const endpoint = new URL(`https://outlook.office.com/api/v2.0/me/MailFolders/${encodeURIComponent(folder.id)}/messages`);
          endpoint.searchParams.set("$top", "20");
          endpoint.searchParams.set("$orderby", "ReceivedDateTime desc");
          endpoint.searchParams.set("$select", "Subject,ReceivedDateTime,Body,BodyPreview");
          const mailRes = await fetch(endpoint, {
            headers: { "Authorization": "Bearer " + tokenJson.access_token }
          });
          const mailJson = await mailRes.json().catch(() => ({}));
          if (!mailRes.ok) {
            if (mailRes.status === 404) continue;
            throw new Error(`邮箱邮件读取失败：${mailJson.error && (mailJson.error.code || mailJson.error.message) || mailRes.status}`);
          }
          if (mailJson && mailJson.value) {
            for (const m of mailJson.value) {
              const subject = String(m.Subject || "");
            const receivedTime = m.ReceivedDateTime ? Date.parse(m.ReceivedDateTime) : 0;
              if (receivedTime >= sentAfter) {
                const code = extractVerificationCode(subject, m.Body && m.Body.Content ? m.Body.Content : (m.BodyPreview || ""));
                if (code) {
                  return { code, method: `微软官方 API ${folder.label}`, subject };
                }
              }
            }
          }
        }
      }
    } catch (err) {
      throw new Error(err.message || "邮箱读取失败");
    }
  }

  try {
    const api_key = OUTLOOK007_API_KEY;
    const pt = getPtForEmail(cleanEmail);
    if (!api_key || !pt) return null;
    const url = `http://ms.outlook007.cc/api/open/email/latest?api_key=${api_key}&pt=${pt}&email=${encodeURIComponent(cleanEmail)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json && json.status === "success" && json.body) {
      const subject = String(json.subject || "");
      const isMatch = subject.includes("登录代码") || 
                      subject.includes("验证码") || 
                      subject.includes("verification code") || 
                      subject.includes("登入码") ||
                      subject.includes("OpenAI") ||
                      subject.includes("ChatGPT");
      const receivedTime = json.received_at ? Date.parse(json.received_at) : 0;
      if (isMatch && receivedTime >= sentAfter) {
        const body = cleanHtml(json.body);
        const match = body.match(/\b\d{6}\b/);
        if (match) {
          return { code: match[0], method: "outlook007.cc 接口", subject };
        }
      }
    }
  } catch (err) {
    // Quietly fall through on backup API errors.
  }

  return null;
}

const autoRefreshState = {
  status: "idle",
  logs: [],
  currentIndex: null,
  processed: 0,
  total: 0,
  successCount: 0,
  failedCount: 0,
  taskId: null,
};

function addAutoLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  autoRefreshState.logs.push(line);
  if (autoRefreshState.logs.length > 200) {
    autoRefreshState.logs.shift();
  }
}

function blockAutoRefreshAccount(index, reason) {
  const accounts = readAccounts();
  const account = accounts[index];
  if (!account) return;
  account.auto_refresh_blocked = true;
  account.auto_refresh_block_reason = reason;
  account.auto_refresh_blocked_at = formatLocalDate(new Date());
  writeAccounts(accounts);
}

function shouldBlockAutoRefresh(error) {
  if (error && error.blockAutoRefresh) return true;
  return Boolean(abnormalAccountReason(error && error.message));
}

async function executeAutoRefresh(indexes) {
  autoRefreshState.status = "running";
  autoRefreshState.logs = [];
  autoRefreshState.processed = 0;
  autoRefreshState.total = indexes.length;
  autoRefreshState.successCount = 0;
  autoRefreshState.failedCount = 0;
  autoRefreshState.taskId = crypto.randomUUID();

  addAutoLog(`[启动] 开始全自动批量刷新，计划处理 ${indexes.length} 个账号...`);

  for (let i = 0; i < indexes.length; i++) {
    if (autoRefreshState.status !== "running") {
      addAutoLog(`[中断] 任务已被用户停止。`);
      break;
    }

    const index = indexes[i];
    const accounts = readAccounts();
    const account = accounts[index];
    if (!account) {
      addAutoLog(`[跳过] 无效账号序号 #${index + 1}`);
      autoRefreshState.processed++;
      continue;
    }
    if (!autoRefreshableAccount(account)) {
      const reason = mailboxReadable(account) ? "凭证仍有效" : "缺少可用邮箱授权";
      addAutoLog(`[跳过] 账号 #${index + 1}: ${account.email}，${reason}。`);
      autoRefreshState.processed++;
      continue;
    }

    autoRefreshState.currentIndex = index;
    addAutoLog(`[进度 ${i + 1}/${indexes.length}] 开始刷新账号 #${index + 1}: ${account.email}`);

    let session = null;
    try {
      const triggerTime = Date.now();
      addAutoLog(`正在启动 Chrome 浏览器并触发 OpenAI 验证码...`);
      session = await beginLogin(index);
      addAutoLog(`验证码已发送。等待 8 秒后开始拉取邮箱验证码...`);
      await new Promise(r => setTimeout(r, 8000));

      let codeObj = null;
      const startPoll = Date.now();
      const timeout = 60000;
      while (Date.now() - startPoll < timeout) {
        if (autoRefreshState.status !== "running") break;
        
        addAutoLog(`正在尝试获取最新邮件验证码...`);
        codeObj = await fetchEmailCode(account.email, account.mailbox_client_id, account.mailbox_refresh_token, triggerTime - 60000);
        if (codeObj) {
          addAutoLog(`成功提取验证码：[${codeObj.code}]，来源：[${codeObj.method}]`);
          break;
        }
        await new Promise(r => setTimeout(r, 4500));
      }

      if (autoRefreshState.status !== "running") {
        throw new Error(`批量刷新已被用户停止`);
      }

      if (!codeObj) {
        throw new Error(`在 60 秒内未能在邮箱中找到最新的 OpenAI 验证码邮件`);
      }

      addAutoLog(`正在填写验证码 [${codeObj.code}] 并提交到登录页面...`);
      
      const submitResult = await submitOtp(session.id, codeObj.code, (msg) => {
        addAutoLog(`页面状态: ${msg}`);
      });

      addAutoLog(`[成功] 账号 ${account.email} 刷新成功，新到期时间: ${submitResult.expired}`);
      autoRefreshState.successCount++;
    } catch (err) {
      addAutoLog(`[失败] 账号 ${account.email} 刷新失败: ${err.message}`);
      if (shouldBlockAutoRefresh(err)) {
        blockAutoRefreshAccount(index, err.message);
        addAutoLog(`[标记] 账号 ${account.email} 已标记为异常，并从自动刷新队列移除：${err.message}`);
      }
      autoRefreshState.failedCount++;
      if (session) {
        try {
          const fullSession = sessions.get(session.id);
          if (fullSession && fullSession.page) {
            const screenshotPath = path.join(path.dirname(ACCOUNTS_PATH), `error_refresh_${index + 1}.png`);
            await fullSession.page.screenshot({ path: screenshotPath });
            addAutoLog(`已保存错误页面截图至：[${screenshotPath}]`);
          } else {
            addAutoLog(`无法获取 fullSession，无法截图`);
          }
        } catch (e) {
          addAutoLog(`保存截图失败: ${e.message}`);
        }
        await closeSession(session.id).catch(() => {});
      }
    }

    autoRefreshState.processed++;
    
    if (i < indexes.length - 1 && autoRefreshState.status === "running") {
      addAutoLog(`等待 5 秒后处理下一个账号...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (autoRefreshState.status === "running") {
    autoRefreshState.status = "done";
    addAutoLog(`[结束] 全自动刷新全部完成。成功: ${autoRefreshState.successCount}，失败: ${autoRefreshState.failedCount}`);
  } else {
    addAutoLog(`[结束] 全自动刷新已终止。成功: ${autoRefreshState.successCount}，失败: ${autoRefreshState.failedCount}`);
  }
}

async function route(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html());
      return;
    }

    if (request.method === "GET" && url.pathname === "/credentials") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(credentialsHtml());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/accounts") {
      const accounts = readAccounts();
      json(response, 200, {
        accounts: accounts.map(accountSummary),
        sessions: [...sessions.values()].map(sessionView),
        backupPath,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/logs") {
      json(response, 200, {
        out: readLogTail(LOG_OUT_PATH),
        err: readLogTail(LOG_ERR_PATH),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      json(response, 200, { jobs: [...jobs.values()].map(jobView) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export") {
      const accounts = readAccounts();
      const type = url.searchParams.get("type");
      if (type === "selected") {
        const index = Number(url.searchParams.get("index")) - 1;
        const account = accounts[index];
        if (!account) throw new Error("account index is out of range");
        downloadJson(response, `codex_account_${index + 1}_${account.email}.json`, account);
        return;
      }

      if (type === "refreshed") {
        const refreshed = accounts.filter((account) => parseDate(account.expired) >= CUTOFF_TS);
        downloadJson(response, "codex_accounts_refreshed_all.json", refreshed);
        return;
      }

      if (type === "indexes") {
        const indexes = parseIndexesParam(url.searchParams.get("indexes"), accounts.length);
        if (indexes.length === 0) throw new Error("no accounts selected");
        const picked = indexes.map((index) => accounts[index]);
        const suffix = indexes.length === 1 ? `${indexes[0] + 1}_${picked[0].email}` : `${indexes.length}_selected`;
        downloadJson(response, `codex_accounts_${suffix}.json`, picked);
        return;
      }

      throw new Error("unknown export type");
    }

    if (request.method === "GET" && url.pathname === "/api/check") {
      const accounts = readAccounts();
      const type = url.searchParams.get("type");
      let source = accounts.map((_, index) => index);
      if (type === "selected") source = [Number(url.searchParams.get("index")) - 1];
      if (type === "indexes") source = parseIndexesParam(url.searchParams.get("indexes"), accounts.length);
      const items = source
        .filter((index) => accounts[index])
        .map((index) => {
          const account = accounts[index];
          return {
            index: index + 1,
            email: account.email,
            expired: credentialStatus(account).expired,
            metadataExpired: credentialStatus(account).metadataExpired,
            tokenExpired: credentialStatus(account).tokenExpired,
            expiredAt: account.expired || "",
            tokenExpiresAt: credentialStatus(account).tokenExpiresAt,
          };
        });
      json(response, 200, {
        items,
        valid: items.filter((item) => !item.expired).length,
        expired: items.filter((item) => item.expired).length,
        unknown: items.filter((item) => item.tokenExpired === null).length,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mail-diagnostics") {
      const accounts = readAccounts();
      const index = Number(url.searchParams.get("index")) - 1;
      const account = accounts[index];
      if (!account) throw new Error("account index is out of range");
      const folders = await mailboxDiagnostics(account);
      json(response, 200, {
        index: index + 1,
        email: account.email,
        folders,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/start") {
      const body = await readJson(request);
      const index = Number(body.index) - 1;
      const session = await beginLogin(index);
      json(response, 200, { session });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const body = await readJson(request);
      const result = importCredentials(body.records, { dryRun: body.dryRun === true });
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJson(request);
      const result = await submitOtp(body.sessionId, String(body.otp || ""));
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/submit-job") {
      const body = await readJson(request);
      const job = startSubmitJob(body.sessionId, String(body.otp || ""));
      json(response, 200, { job });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/close") {
      const body = await readJson(request);
      const closed = await closeSession(body.sessionId);
      json(response, 200, { closed });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auto-refresh/start") {
      const body = await readJson(request);
      const requestedIndexes = body.indexes;
      if (!Array.isArray(requestedIndexes)) throw new Error("indexes must be an array");
      const accounts = readAccounts();
      const indexes = requestedIndexes.filter((index) => accounts[index] && autoRefreshableAccount(accounts[index]));
      if (indexes.length === 0) {
        json(response, 400, { error: "没有自动待刷新的账号" });
        return;
      }
      if (autoRefreshState.status === "running") {
        json(response, 409, { error: "自动刷新任务正在运行" });
        return;
      }
      executeAutoRefresh(indexes).catch(err => {
        console.error("Auto refresh execution error:", err);
      });
      json(response, 200, { status: "started" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auto-refresh/stop") {
      autoRefreshState.status = "stopped";
      json(response, 200, { status: "stopped" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auto-refresh/status") {
      json(response, 200, { state: autoRefreshState });
      return;
    }

    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, { error: error.message });
  }
}

const server = http.createServer(route);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Codex OAuth WebUI: http://127.0.0.1:${PORT}`);
  console.log(`Accounts: ${ACCOUNTS_PATH}`);
});
