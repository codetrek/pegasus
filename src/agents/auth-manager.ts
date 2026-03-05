/**
 * AuthManager — handles OAuth authentication flows for LLM providers.
 *
 * Extracted from MainAgent to isolate authentication concerns:
 * - Codex device code login + token refresh
 * - GitHub Copilot login + token refresh
 * - Model limits fetching from provider APIs
 * - OAuth credential file I/O
 */

import {
  refreshOpenAICodexToken,
  loginGitHubCopilot,
  refreshGitHubCopilotToken,
  getGitHubCopilotBaseUrl,
  type OAuthCredentials,
} from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loginCodexDeviceCode } from "../infra/codex-device-login.ts";
import { errorToString } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";
import type { Settings } from "../infra/config.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import {
  ModelLimitsCache,
  CopilotModelFetcher,
  OpenRouterModelFetcher,
} from "../context/index.ts";
import type { ProviderModelFetcher } from "../context/index.ts";

const logger = getLogger("auth_manager");

export interface AuthManagerDeps {
  settings: Settings;
  models: ModelRegistry;
  modelLimitsCache: ModelLimitsCache;
  /** Directory containing credential JSON files (codex.json, github-copilot.json). */
  credDir: string;
}

export class AuthManager {
  private settings: Settings;
  private models: ModelRegistry;
  private modelLimitsCache: ModelLimitsCache;
  private _codexCredPath: string;
  private _copilotCredPath: string;
  private _copilotBaseURL?: string;
  private _copilotTokenProvider?: () => Promise<string>;

  constructor(deps: AuthManagerDeps) {
    this.settings = deps.settings;
    this.models = deps.models;
    this.modelLimitsCache = deps.modelLimitsCache;

    const { join } = require("node:path");
    this._codexCredPath = join(deps.credDir, "codex.json");
    this._copilotCredPath = join(deps.credDir, "github-copilot.json");
  }

  /** Run all auth flows: Codex, Copilot, and model limits. */
  async initialize(): Promise<void> {
    await this._initCodexAuth();
    await this._initCopilotAuth();
    await this._initModelLimits();
  }

  /** Get the Copilot token provider (for MCP token refresh and model limits). */
  get copilotTokenProvider(): (() => Promise<string>) | undefined {
    return this._copilotTokenProvider;
  }

  /** Get the Copilot base URL. */
  get copilotBaseURL(): string | undefined {
    return this._copilotBaseURL;
  }

  // ── Codex OAuth ──

  /**
   * Async Codex auth — runs device code login if sync load didn't find credentials.
   * Called from initialize() so it can do async operations (token refresh, interactive login).
   * Uses our own loginCodexDeviceCode (device code flow, headless-friendly)
   * and pi-ai's refreshOpenAICodexToken for token refresh.
   */
  private async _initCodexAuth(): Promise<void> {
    const codexConfig = this.settings.llm?.codex;
    if (!codexConfig?.enabled) return;

    try {
      // Try loading stored credentials
      let creds = this._loadOAuthCredentials(this._codexCredPath);

      // If stored credentials exist, try refreshing if expired
      if (creds && Date.now() >= creds.expires) {
        try {
          logger.info("codex_token_refreshing");
          creds = await refreshOpenAICodexToken(creds.refresh);
          this._saveOAuthCredentials(this._codexCredPath, creds);
          logger.info("codex_token_refreshed");
        } catch {
          logger.warn("codex_token_refresh_failed, re-authenticating");
          creds = null;
        }
      }

      if (!creds) {
        // No valid credentials → interactive device code login
        logger.info("codex_device_code_login_required");
        creds = await loginCodexDeviceCode();
        this._saveOAuthCredentials(this._codexCredPath, creds);
      }

      // Set credentials on ModelRegistry so Codex models can be created
      this.models.setCodexCredentials(
        {
          accessToken: creds.access,
          refreshToken: creds.refresh,
          expiresAt: creds.expires,
          accountId: (creds as Record<string, unknown>).accountId as string ?? "",
        },
        codexConfig.baseURL,
        this._codexCredPath,
      );
      logger.info("codex_auth_ready");
    } catch (err) {
      logger.error(
        { error: errorToString(err) },
        "codex_auth_failed",
      );
      // Continue without Codex — other providers still work
    }
  }

  /**
   * Async Copilot auth — runs GitHub device code login if no stored credentials.
   * Called from initialize() so it can do async operations (token exchange, interactive login).
   * Uses pi-ai's loginGitHubCopilot and refreshGitHubCopilotToken.
   */
  private async _initCopilotAuth(): Promise<void> {
    const copilotConfig = this.settings.llm?.copilot;
    if (!copilotConfig?.enabled) return;

    try {
      // Try loading stored credentials
      let creds = this._loadOAuthCredentials(this._copilotCredPath);

      // If stored credentials exist, try refreshing if expired
      if (creds && Date.now() >= creds.expires) {
        try {
          logger.info("copilot_token_refreshing");
          creds = await refreshGitHubCopilotToken(creds.refresh);
          this._saveOAuthCredentials(this._copilotCredPath, creds);
          logger.info("copilot_token_refreshed");
        } catch {
          logger.warn("copilot_token_refresh_failed, re-authenticating");
          creds = null;
        }
      }

      if (!creds) {
        // No valid credentials → interactive device code login
        logger.info("copilot_device_code_login_required");
        creds = await loginGitHubCopilot({
          onAuth: (url, instructions) => {
            console.log(`\nVisit ${url}`);
            if (instructions) console.log(instructions);
            console.log("(expires in 15 minutes)\n");
          },
          onPrompt: async (prompt) => {
            console.log(prompt.message);
            return "";
          },
          onProgress: (message) => {
            logger.info({ message }, "copilot_login_progress");
          },
        });
        this._saveOAuthCredentials(this._copilotCredPath, creds);
      }

      // Derive base URL from token
      const baseURL = getGitHubCopilotBaseUrl(creds.access);

      // Set credentials on ModelRegistry so Copilot models can be created
      this.models.setCopilotCredentials(
        creds.access,
        baseURL,
        this._copilotCredPath,
      );
      logger.info("copilot_auth_ready");

      // Store connection info for model limits fetching
      this._copilotBaseURL = baseURL;
      this._copilotTokenProvider = async () => {
        // Read fresh credentials from disk (they may have been refreshed)
        const freshCreds = this._loadOAuthCredentials(this._copilotCredPath);
        if (!freshCreds) throw new Error("No Copilot credentials");
        if (Date.now() >= freshCreds.expires) {
          const refreshed = await refreshGitHubCopilotToken(freshCreds.refresh);
          this._saveOAuthCredentials(this._copilotCredPath, refreshed);
          return refreshed.access;
        }
        return freshCreds.access;
      };
    } catch (err) {
      logger.error(
        { error: errorToString(err) },
        "copilot_auth_failed",
      );
      // Continue without Copilot — other providers still work
    }
  }

  /**
   * Fetch model limits from enabled providers.
   * First-run (no disk cache): await fetch (blocking).
   * Subsequent (disk cache exists): background refresh (non-blocking).
   */
  private async _initModelLimits(): Promise<void> {
    const awaitable: Promise<void>[] = [];
    const background: Promise<void>[] = [];

    const doFetch = (fetcher: ProviderModelFetcher) => () => {
      return fetcher.fetch().then((models) => {
        if (models.size > 0) {
          this.modelLimitsCache.update(fetcher.provider, models);
          logger.info({ provider: fetcher.provider, count: models.size }, "model_limits_updated");
        }
      });
    };

    // Copilot
    if (this._copilotTokenProvider && this._copilotBaseURL) {
      const fetcher = new CopilotModelFetcher(this._copilotTokenProvider, this._copilotBaseURL);
      const task = doFetch(fetcher);
      if (this.modelLimitsCache.hasProviderCache("copilot")) {
        background.push(task().catch(err =>
          logger.warn({ provider: "copilot", error: String(err) }, "model_limits_bg_refresh_failed")
        ));
      } else {
        awaitable.push(task().catch(err =>
          logger.warn({ provider: "copilot", error: String(err) }, "model_limits_first_fetch_failed")
        ));
      }
    }

    // OpenRouter
    const orConfig = this.settings.llm?.openrouter;
    if (orConfig?.enabled && orConfig?.apiKey) {
      const fetcher = new OpenRouterModelFetcher(orConfig.apiKey);
      const task = doFetch(fetcher);
      if (this.modelLimitsCache.hasProviderCache("openrouter")) {
        background.push(task().catch(err =>
          logger.warn({ provider: "openrouter", error: String(err) }, "model_limits_bg_refresh_failed")
        ));
      } else {
        awaitable.push(task().catch(err =>
          logger.warn({ provider: "openrouter", error: String(err) }, "model_limits_first_fetch_failed")
        ));
      }
    }

    // Await first-run fetches (blocking — adds seconds to first startup)
    if (awaitable.length > 0) {
      logger.info({ count: awaitable.length }, "model_limits_first_run_awaiting");
      await Promise.all(awaitable);
    }

    // Background refreshes fire-and-forget
    if (background.length > 0) {
      Promise.all(background).then(() =>
        logger.info("model_limits_bg_refresh_complete")
      );
    }
  }

  // ── OAuth credential file helpers ──

  /** Load OAuth credentials from a JSON file. Returns null if not found or invalid.
   *  Supports both pi-ai format { access, refresh, expires } and
   *  old Pegasus format { accessToken, refreshToken, expiresAt, accountId }.
   */
  _loadOAuthCredentials(credPath: string): OAuthCredentials | null {
    if (!existsSync(credPath)) return null;
    try {
      const content = readFileSync(credPath, "utf-8");
      const raw = JSON.parse(content) as Record<string, unknown>;

      // Support new pi-ai format: { access, refresh, expires }
      if (typeof raw.access === "string" && typeof raw.refresh === "string") {
        return raw as unknown as OAuthCredentials;
      }

      // Support old Pegasus format: { accessToken, refreshToken, expiresAt, accountId }
      if (typeof raw.accessToken === "string" && typeof raw.refreshToken === "string") {
        const converted: OAuthCredentials = {
          access: raw.accessToken as string,
          refresh: raw.refreshToken as string,
          expires: (raw.expiresAt as number) ?? 0,
        };
        // Preserve accountId if present (Codex needs it)
        if (raw.accountId) {
          converted.accountId = raw.accountId;
        }
        return converted;
      }

      return null;
    } catch {
      return null;
    }
  }

  /** Save OAuth credentials to a JSON file. */
  _saveOAuthCredentials(credPath: string, creds: OAuthCredentials): void {
    writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");
  }
}
