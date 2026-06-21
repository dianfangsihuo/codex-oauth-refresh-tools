#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const DEFAULT_ACCOUNTS = path.resolve(process.cwd(), "codex_accounts.local.json");
const DEFAULT_CUTOFF = "2026-06-27T00:00:00+08:00";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
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
      // Try the next known module root.
    }
  }

  throw new Error(
    "Playwright was not found. Run: npm install playwright"
  );
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

function parseDate(value) {
  return new Date(String(value).replace(/\//g, "-")).getTime() || 0;
}

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function selectAccounts(accounts, cutoff, indexesArg, limit) {
  let selected = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => parseDate(account.expired) < cutoff);

  if (indexesArg) {
    const wanted = new Set(
      indexesArg
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 0)
    );
    selected = accounts
      .map((account, index) => ({ account, index }))
      .filter(({ index }) => wanted.has(index + 1));
  }

  if (limit > 0) {
    selected = selected.slice(0, limit);
  }

  return selected;
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

async function clickOneTimeCode(page) {
  const button = page.getByRole("button", { name: /使用一次性验证码登录|one-time|code/i });
  await button.click({ timeout: 15000 });
}

async function beginLogin(chromium, target, headed) {
  const pkce = makePkce();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !headed,
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

  await page.goto(authUrl(pkce), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first().fill(target.account.email);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await clickOneTimeCode(page);
  await page.waitForTimeout(2500);

  const body = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  if (!page.url().includes("/email-verification") || /糟糕|Route Error|Invalid content type/i.test(body)) {
    throw new Error(`failed to open OTP page: ${page.url()} ${body.slice(0, 120)}`);
  }

  return { ...target, browser, page, pkce, getCallbackUrl: () => callbackUrl };
}

async function submitOtp(session, otp) {
  const { page, pkce, getCallbackUrl } = session;
  await page.locator('input[name="code"], input[placeholder*="验证码"], input[type="text"]').first().fill(otp);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  try {
    await page.getByRole("button", { name: /继续|Continue|Allow|Authorize/i }).click({ timeout: 5000 });
    await page.waitForTimeout(2500);
  } catch {
    // Consent is not always shown.
  }

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const url = getCallbackUrl() || page.url();
    if (url.startsWith(REDIRECT_URI)) {
      const callback = new URL(url);
      if (callback.searchParams.get("state") !== pkce.state) {
        throw new Error("callback state mismatch");
      }
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("callback is missing code");
      return exchangeAuthCode(code, pkce.verifier);
    }

    const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (/代码不正确|incorrect|invalid code/i.test(body)) {
      throw new Error("OTP was rejected by the login page");
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`no callback after OTP submit; current page is ${page.url()}`);
}

function writeAccounts(accountsPath, accounts) {
  fs.writeFileSync(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, "utf8");
}

function appendProgress(summary) {
  const progressPath = path.resolve(argValue("--progress", path.join(process.cwd(), "progress.md")));
  const lines = [
    "",
    `## 2026-06-17 - Task: Batch refresh Codex OAuth accounts`,
    "### What was done",
    `- Ran the local batch OAuth refresher and refreshed ${summary.refreshed} account(s).`,
    "",
    "### Testing",
    "- Verified each successful account by receiving an OAuth callback, exchanging the authorization code, and writing new token fields back to the account JSON.",
    "",
    "### Notes",
    "- `scripts/codex-oauth-batch-refresh.mjs`: local semi-automated OAuth refresh helper.",
    `- \`${path.basename(summary.accountsPath)}\`: updated only for accounts that completed OAuth successfully.`,
    `- Rollback: restore from the backup created for this run: ${summary.backupPath}`,
    "",
  ];
  fs.appendFileSync(progressPath, lines.join("\n"), "utf8");
}

async function main() {
  const accountsPath = path.resolve(argValue("--accounts", DEFAULT_ACCOUNTS));
  const indexes = argValue("--indexes", "");
  const limit = Number(argValue("--limit", "0"));
  const cutoff = Date.parse(argValue("--cutoff", DEFAULT_CUTOFF));
  const headed = !hasArg("--headless");
  const batchSize = Math.max(1, Number(argValue("--batch", "1")) || 1);
  const playwright = loadPlaywright();
  const rl = readline.createInterface({ input, output });

  const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
  const targets = selectAccounts(accounts, cutoff, indexes, limit);
  if (targets.length === 0) {
    console.log("No accounts matched the refresh criteria.");
    rl.close();
    return;
  }

  const backupPath = `${accountsPath}.bak_batch_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(accountsPath, backupPath);
  console.log(`Backup: ${backupPath}`);
  console.log(`Selected ${targets.length} account(s). Batch size: ${batchSize}`);
  console.log("OTP is never read from mailbox by this script. Paste each code when prompted.");

  let refreshed = 0;
  const failed = [];

  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize);
    const sessions = [];

    for (const target of batch) {
      const label = `#${target.index + 1} ${target.account.email}`;
      try {
        console.log(`\nOpening OTP page for ${label}`);
        sessions.push(await beginLogin(playwright.chromium, target, headed));
      } catch (error) {
        failed.push({ index: target.index + 1, email: target.account.email, error: error.message });
        console.log(`Failed before OTP for ${label}: ${error.message}`);
      }
    }

    for (const session of sessions) {
      const label = `#${session.index + 1} ${session.account.email}`;
      try {
        const otp = (await rl.question(`OTP for ${label} (empty=skip): `)).trim();
        if (!otp) {
          failed.push({ index: session.index + 1, email: session.account.email, error: "skipped by user" });
          await session.browser.close();
          continue;
        }

        const token = await submitOtp(session, otp);
        const account = accounts[session.index];
        account.id_token = token.id_token || account.id_token;
        account.access_token = token.access_token || account.access_token;
        account.refresh_token = token.refresh_token || account.refresh_token;
        const now = new Date();
        account.last_refresh = formatLocalDate(now);
        account.expired = formatLocalDate(new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000));
        writeAccounts(accountsPath, accounts);
        refreshed += 1;
        console.log(`Refreshed ${label}; expires ${account.expired}`);
      } catch (error) {
        failed.push({ index: session.index + 1, email: session.account.email, error: error.message });
        console.log(`Failed after OTP for ${label}: ${error.message}`);
      } finally {
        await session.browser.close().catch(() => {});
      }
    }
  }

  rl.close();
  if (refreshed > 0) appendProgress({ refreshed, backupPath, accountsPath });

  console.log("\nDone.");
  console.log(`Refreshed: ${refreshed}`);
  console.log(`Failed/skipped: ${failed.length}`);
  for (const item of failed) {
    console.log(`- #${item.index} ${item.email}: ${item.error}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
