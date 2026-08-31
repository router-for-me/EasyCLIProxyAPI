import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useI18n } from "../i18n";
import {
  isRecord,
  managementApi,
  readBoolean,
  readString,
  responseList,
} from "../services/managementApi";
import {
  fetchModels,
  normalizeBaseUrl,
  type ModelOption,
  type ModelProvider,
} from "../services/modelService";
import { AgentsPage } from "./AgentsPage";

import codexIcon from "../assets/icons/codex.svg";
import claudeIcon from "../assets/icons/claude.svg";
import antigravityIcon from "../assets/icons/antigravity.svg";
import kimiIcon from "../assets/icons/kimi-light.svg";
import grokIcon from "../assets/icons/grok.svg";
import openaiIcon from "../assets/icons/openai-light.svg";
import deepseekIcon from "../assets/icons/deepseek.svg";
import geminiIcon from "../assets/icons/gemini.svg";

type AuthMethod = "oauth" | "api";
type SetupStep = 1 | 2;

type OAuthProviderId = "codex" | "claude" | "antigravity" | "kimi" | "xai";

type OAuthProviderInfo = {
  id: OAuthProviderId;
  name: string;
  icon: string;
  description: string;
};

const oauthProviders: OAuthProviderInfo[] = [
  { id: "codex", name: "Codex OAuth", icon: codexIcon, description: "OpenAI / ChatGPT 账号授权登录" },
  { id: "claude", name: "Claude OAuth", icon: claudeIcon, description: "Anthropic / Claude 账号授权登录" },
  { id: "antigravity", name: "Antigravity OAuth", icon: antigravityIcon, description: "Antigravity 账号授权登录" },
  { id: "kimi", name: "Kimi OAuth", icon: kimiIcon, description: "Moonshot / Kimi 账号授权登录" },
  { id: "xai", name: "xAI OAuth", icon: grokIcon, description: "xAI / Grok 账号授权登录" },
];

type ApiSection = "openai-compatibility" | "deepseek" | "claude" | "gemini" | "codex";
type ApiManagementSection = "openai-compatibility" | "claude-api-key" | "codex-api-key" | "gemini-api-key";

type ApiSectionOption = {
  id: ApiSection;
  managementSection: ApiManagementSection;
  name: string;
  provider: ModelProvider;
  defaultBaseUrl: string;
  icon: string;
};

const apiSectionOptions: ApiSectionOption[] = [
  { id: "openai-compatibility", managementSection: "openai-compatibility", name: "OpenAI 格式", provider: "openai", defaultBaseUrl: "", icon: openaiIcon },
  { id: "claude", managementSection: "claude-api-key", name: "Anthropic 格式", provider: "claude", defaultBaseUrl: "", icon: claudeIcon },
  { id: "codex", managementSection: "codex-api-key", name: "Codex API", provider: "codex", defaultBaseUrl: "", icon: codexIcon },
  { id: "gemini", managementSection: "gemini-api-key", name: "Gemini 格式", provider: "gemini", defaultBaseUrl: "", icon: geminiIcon },
  { id: "deepseek", managementSection: "openai-compatibility", name: "DeepSeek", provider: "openai", defaultBaseUrl: "https://api.deepseek.com", icon: deepseekIcon },
];

const isDeepSeekRecord = (record: Record<string, unknown>) => {
  const name = readString(record, "name").trim().toLowerCase();
  const baseUrl = readString(record, "base-url", "baseUrl").trim().toLowerCase();
  return name.includes("deepseek") || /^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl);
};

export function EasyModePage({
  onExit,
}: {
  onExit?: () => void;
}) {
  const { t } = useI18n();

  const [activeStep, setActiveStep] = useState<SetupStep>(1);
  const [authMethod, setAuthMethod] = useState<AuthMethod>("oauth");

  const [loadingSources, setLoadingSources] = useState(true);
  const [authFiles, setAuthFiles] = useState<Record<string, unknown>[]>([]);
  const [apiCounts, setApiCounts] = useState<Record<ApiSection, number>>({
    "openai-compatibility": 0,
    deepseek: 0,
    claude: 0,
    gemini: 0,
    codex: 0,
  });
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);

  const [oauthLoggingIn, setOauthLoggingIn] = useState<OAuthProviderId | null>(null);
  const [oauthNotice, setOauthNotice] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const oauthPollTimer = useRef<number | null>(null);

  const [selectedApiSection, setSelectedApiSection] = useState<ApiSection>("openai-compatibility");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiRemark, setApiRemark] = useState("");
  const [apiTesting, setApiTesting] = useState(false);
  const [apiTestedModels, setApiTestedModels] = useState<ModelOption[]>([]);
  const [apiSelectedModels, setApiSelectedModels] = useState<ModelOption[]>([]);
  const [apiCustomModelId, setApiCustomModelId] = useState("");
  const [apiTestError, setApiTestError] = useState("");
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaveNotice, setApiSaveNotice] = useState<string | null>(null);

  const refreshSourceStatus = useCallback(async () => {
    setLoadingSources(true);
    try {
      const authFilesPayload = await managementApi.get("/auth-files");
      const files = responseList(authFilesPayload, "files");
      setAuthFiles(files);

      const counts: Record<ApiSection, number> = {
        "openai-compatibility": 0,
        deepseek: 0,
        claude: 0,
        gemini: 0,
        codex: 0,
      };
      const allFetchedModels: ModelOption[] = [];

      const configPayload = await managementApi.get("/config");
      const recordsBySection: Record<ApiManagementSection, Record<string, unknown>[]> = {
        "openai-compatibility": responseList(configPayload, "openai-compatibility"),
        "claude-api-key": responseList(configPayload, "claude-api-key"),
        "codex-api-key": responseList(configPayload, "codex-api-key"),
        "gemini-api-key": responseList(configPayload, "gemini-api-key"),
      };

      for (const section of apiSectionOptions) {
        const sourceList = recordsBySection[section.managementSection];
        const list = section.id === "deepseek"
          ? sourceList.filter(isDeepSeekRecord)
          : section.id === "openai-compatibility"
            ? sourceList.filter((record) => !isDeepSeekRecord(record))
            : sourceList;
        counts[section.id] = list.length;
        list.forEach((item) => {
          if (Array.isArray(item.models)) {
            item.models.forEach((m) => {
              const name = typeof m === "string" ? m : readString(m, "name", "id");
              if (name && !allFetchedModels.some((x) => x.name === name)) {
                allFetchedModels.push({ name });
              }
            });
          }
        });
      }
      setApiCounts(counts);

      setAvailableModels(allFetchedModels);
    } catch (e) {
      console.warn("Failed to refresh source status", e);
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    void refreshSourceStatus();
    return () => {
      if (oauthPollTimer.current) window.clearInterval(oauthPollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!oauthNotice) return undefined;
    const timer = window.setTimeout(() => {
      setOauthNotice(null);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [oauthNotice]);

  const handleStartOAuth = async (provider: OAuthProviderId) => {
    if (oauthPollTimer.current) window.clearInterval(oauthPollTimer.current);
    setOauthLoggingIn(provider);
    setOauthNotice(null);

    try {
      const result = await invoke<{
        url?: string;
        state?: string;
        opened?: boolean;
        openError?: string;
      }>("start_oauth_login", {
        provider,
        browser: "default",
      });

      if (!result.state) {
        setOauthNotice({
          tone: "error",
          message: "获取授权状态失败，请重试",
        });
        setOauthLoggingIn(null);
        return;
      }

      const stateKey = result.state;
      oauthPollTimer.current = window.setInterval(async () => {
        try {
          const pollRes = await invoke<{ status: string; error?: string }>(
            "get_oauth_status",
            { state: stateKey },
          );
          const status = (pollRes.status || "").toLowerCase();
          if (status === "ok") {
            if (oauthPollTimer.current) window.clearInterval(oauthPollTimer.current);
            setOauthLoggingIn(null);
            setOauthNotice({
              tone: "success",
              message: "登录成功！已成功授权并获取账号额度。",
            });
            void refreshSourceStatus();
          } else if (status === "error") {
            if (oauthPollTimer.current) window.clearInterval(oauthPollTimer.current);
            setOauthLoggingIn(null);
            setOauthNotice({
              tone: "error",
              message: pollRes.error ? `授权失败: ${pollRes.error}` : "授权失败，请重试",
            });
          }
        } catch {}
      }, 1500);
    } catch (err) {
      setOauthLoggingIn(null);
      setOauthNotice({
        tone: "error",
        message: String(err),
      });
    }
  };
  const handleApiSectionChange = (sec: ApiSection) => {
    setSelectedApiSection(sec);
    const opt = apiSectionOptions.find((o) => o.id === sec);
    if (opt) setApiBaseUrl(opt.defaultBaseUrl);
    setApiTestedModels([]);
    setApiSelectedModels([]);
    setApiCustomModelId("");
    setApiTestError("");
    setApiSaveNotice(null);
  };

  const handleTestApi = async () => {
    if (!apiBaseUrl.trim()) {
      setApiTestError("请先填写 API URL");
      return;
    }
    setApiTesting(true);
    setApiTestError("");
    setApiTestedModels([]);

    const opt = apiSectionOptions.find((o) => o.id === selectedApiSection);
    const providerType = opt ? opt.provider : "openai";

    try {
      const models = await fetchModels(
        providerType,
        apiBaseUrl.trim(),
        apiKey.trim(),
        undefined,
        {},
        10000,
      );
      if (models.length > 0) {
        setApiTestedModels(models);
        setApiSelectedModels((current) => {
          const fetchedKeys = new Set(models.map((model) => model.name.trim().toLowerCase()));
          const customModels = current.filter((model) => !fetchedKeys.has(model.name.trim().toLowerCase()));
          return [...models, ...customModels];
        });
      } else {
        setApiTestError("未获取到任何模型，请检查 API URL 和 API 密钥");
      }
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiTesting(false);
    }
  };

  const handleToggleApiModel = (model: ModelOption) => {
    const key = model.name.trim().toLowerCase();
    if (!key) return;
    setApiSelectedModels((current) => {
      const selected = current.some((item) => item.name.trim().toLowerCase() === key);
      return selected
        ? current.filter((item) => item.name.trim().toLowerCase() !== key)
        : [...current, model];
    });
  };

  const handleAddCustomModel = () => {
    const name = apiCustomModelId.trim();
    if (!name) return;
    const key = name.toLowerCase();
    setApiSelectedModels((current) => {
      if (current.some((model) => model.name.trim().toLowerCase() === key)) return current;
      const fetchedModel = apiTestedModels.find((model) => model.name.trim().toLowerCase() === key);
      return [...current, fetchedModel ?? { name }];
    });
    setApiCustomModelId("");
    setApiTestError("");
  };

  const handleSaveApi = async () => {
    if (!apiBaseUrl.trim()) {
      setApiTestError("请先填写 API URL");
      return;
    }
    if (apiSelectedModels.length === 0) {
      setApiTestError(t("easyMode.api.modelRequired"));
      return;
    }
    setApiSaving(true);
    setApiSaveNotice(null);
    setApiTestError("");

    try {
      const selectedOption = apiSectionOptions.find((option) => option.id === selectedApiSection);
      const managementSection = selectedOption?.managementSection ?? "openai-compatibility";
      const configPayload = await managementApi.get("/config");
      const list = responseList(configPayload, managementSection);
      const models = apiSelectedModels.map((model) => ({ name: model.name.trim() }));
      const newEntry = managementSection === "openai-compatibility"
        ? {
          name: apiRemark.trim() || `${selectedApiSection} (${list.length + 1})`,
          "base-url": normalizeBaseUrl(apiBaseUrl.trim()),
          "api-key-entries": [
            { "api-key": apiKey.trim() },
          ],
          models,
        }
        : {
          "api-key": apiKey.trim(),
          "base-url": normalizeBaseUrl(apiBaseUrl.trim()),
          models,
        };

      await managementApi.put(`/${managementSection}`, [...list, newEntry]);
      setApiSaveNotice("API 接入已保存成功！");
      void refreshSourceStatus();
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiSaving(false);
    }
  };

  const isOAuthLoggedIn = (providerId: OAuthProviderId) => {
    const norm = providerId === "claude" ? "claude" : providerId === "codex" ? "codex" : providerId;
    return authFiles.some((f) => {
      const p = readString(f, "provider", "type").toLowerCase();
      return p.includes(norm) || (norm === "codex" && p.includes("openai")) || (norm === "claude" && p.includes("anthropic"));
    });
  };

  const totalLoggedInOAuth = oauthProviders.filter((p) => isOAuthLoggedIn(p.id)).length;
  const totalApiProviders = Object.values(apiCounts).reduce((a, b) => a + b, 0);
  const hasConnectedSource = totalLoggedInOAuth > 0 || totalApiProviders > 0;
  const displayedApiModels = useMemo(() => {
    const fetchedKeys = new Set(apiTestedModels.map((model) => model.name.trim().toLowerCase()));
    return [
      ...apiTestedModels,
      ...apiSelectedModels.filter((model) => !fetchedKeys.has(model.name.trim().toLowerCase())),
    ];
  }, [apiSelectedModels, apiTestedModels]);

  const setupStepStatus = t("easyMode.steps.current", {
    current: activeStep,
    total: 2,
  });

  return (
    <section className="page simple-mode-page">
      <nav className="simple-mode-step-status" aria-label={t("easyMode.steps.label")}>
        <div className="simple-mode-step-status-heading">
          <span>{t("easyMode.steps.label")}</span>
          <strong>{setupStepStatus}</strong>
        </div>
        <div className="simple-mode-step-status-track">
          <div
            className={`simple-mode-step-status-item${activeStep === 1 ? " active" : " complete"}`}
            aria-current={activeStep === 1 ? "step" : undefined}
          >
            <span className="simple-mode-step-status-number">
              {activeStep > 1 ? <Check size={14} aria-hidden="true" /> : "1"}
            </span>
            <span className="simple-mode-step-status-copy">
              <strong>{t("easyMode.overview.providerTitle")}</strong>
              <small>{t("easyMode.steps.step1Description")}</small>
            </span>
          </div>
          <span className={`simple-mode-step-status-connector${activeStep > 1 ? " complete" : ""}`} aria-hidden="true" />
          <div
            className={`simple-mode-step-status-item${activeStep === 2 ? " active" : ""}`}
            aria-current={activeStep === 2 ? "step" : undefined}
          >
            <span className="simple-mode-step-status-number">2</span>
            <span className="simple-mode-step-status-copy">
              <strong>{t("easyMode.overview.agentTitle")}</strong>
              <small>{t("easyMode.steps.step2Description")}</small>
            </span>
          </div>
        </div>
      </nav>

      {/* 第一步：接入模型 */}
      {activeStep === 1 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <div>
              <h2>{t("easyMode.overview.providerTitle")}</h2>
              <p>{t("easyMode.setup.providerDescription")}</p>
            </div>
          </div>

          <div className="simple-mode-choice-grid">
            <button
              type="button"
              className={`simple-mode-choice${authMethod === "oauth" ? " selected" : ""}`}
              aria-pressed={authMethod === "oauth"}
              onClick={() => setAuthMethod("oauth")}
            >
              <div className="simple-mode-choice-heading">
                <div className="simple-mode-choice-title">
                  <strong>{t("easyMode.oauth.title")}</strong>
                  {totalLoggedInOAuth > 0 ? (
                    <span className="state-pill success" style={{ fontSize: "12px" }}>
                      已登录 {totalLoggedInOAuth} 个账号
                    </span>
                  ) : (
                    <span className="state-pill neutral" style={{ fontSize: "12px" }}>推荐</span>
                  )}
                </div>
              </div>
              <span>{t("easyMode.oauth.description")}</span>
              <small>支持 Codex、Claude、Antigravity、Kimi、xAI</small>
            </button>

            <button
              type="button"
              className={`simple-mode-choice${authMethod === "api" ? " selected" : ""}`}
              aria-pressed={authMethod === "api"}
              onClick={() => setAuthMethod("api")}
            >
              <div className="simple-mode-choice-heading">
                <div className="simple-mode-choice-title">
                  <strong>{t("easyMode.api.title")}</strong>
                  {totalApiProviders > 0 ? (
                    <span className="state-pill success" style={{ fontSize: "12px" }}>
                      已接入 {totalApiProviders} 个平台
                    </span>
                  ) : null}
                </div>
              </div>
              <span>{t("easyMode.api.description")}</span>
              <small>支持 OpenAI、Anthropic、Codex、Gemini、DeepSeek</small>
            </button>
          </div>

          {authMethod === "oauth" ? (
            <div className="simple-mode-embedded-box">
              {oauthNotice ? (
                <div
                  className={`config-toast ${oauthNotice.tone}`}
                >
                  {oauthNotice.tone === "success" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  <span>{oauthNotice.message}</span>
                </div>
              ) : null}

              <div className="simple-mode-provider-grid">
                {oauthProviders.map((provider) => {
                  const loggedIn = isOAuthLoggedIn(provider.id);
                  const isLogging = oauthLoggingIn === provider.id;

                  return (
                    <article
                      key={provider.id}
                      className={`client-api-card simple-mode-provider-card${loggedIn ? " connected" : ""}`}
                    >
                      <div className="simple-mode-provider-card-head">
                        <span className="client-api-logo simple-mode-provider-logo">
                          <img src={provider.icon} alt="" />
                        </span>
                        <div className="simple-mode-provider-copy">
                          <strong>{provider.name}</strong>
                          <span>
                            {provider.description}
                          </span>
                        </div>
                      </div>

                      <div className="simple-mode-provider-card-foot">
                        {loggedIn ? (
                          <span className="state-pill success" style={{ fontSize: "12px" }}>
                            <Check size={13} style={{ marginRight: 4 }} />
                            {t("easyMode.oauth.loggedIn")}
                          </span>
                        ) : (
                          <span className="state-pill neutral" style={{ fontSize: "12px" }}>未授权</span>
                        )}

                        <button
                          type="button"
                          className={loggedIn ? "secondary-button" : "primary-button"}
                          disabled={isLogging}
                          onClick={() => void handleStartOAuth(provider.id)}
                        >
                          {isLogging ? (
                            <>
                              <LoaderCircle size={14} className="spin" style={{ marginRight: 6 }} />
                              {t("easyMode.oauth.loggingIn")}
                            </>
                          ) : loggedIn ? (
                            t("easyMode.oauth.relogin")
                          ) : (
                            "开始登录"
                          )}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {authMethod === "api" ? (
            <div className="simple-mode-embedded-box">
              {apiSaveNotice ? (
                <div
                  className="config-toast success"
                  style={{ position: "static", transform: "none", margin: 0 }}
                >
                  <CheckCircle2 size={16} />
                  <span>{apiSaveNotice}</span>
                </div>
              ) : null}

              {apiTestError ? (
                <div
                  className="config-toast error"
                  style={{ position: "static", transform: "none", margin: 0 }}
                >
                  <AlertCircle size={16} />
                  <span>{apiTestError}</span>
                </div>
              ) : null}

              <div className="simple-mode-api-form">
                <div className="simple-mode-api-platforms">
                  {apiSectionOptions.map((opt) => (
                    <button
                      type="button"
                      key={opt.id}
                      className={`secondary-button simple-mode-api-platform${selectedApiSection === opt.id ? " active" : ""}`}
                      onClick={() => handleApiSectionChange(opt.id)}
                    >
                      <img className="simple-mode-api-platform-icon" src={opt.icon} alt="" />
                      {opt.name}
                    </button>
                  ))}
                </div>

                <div className="simple-mode-field">
                  <label>
                    {t("easyMode.api.name")}
                  </label>
                  <input
                    type="text"
                    className="text-input"
                    value={apiRemark}
                    onChange={(e) => setApiRemark(e.target.value)}
                    placeholder="例如：主力 DeepSeek V3、中转 API"
                  />
                </div>

                <div className="simple-mode-api-fields">
                  <div className="simple-mode-field">
                    <label>
                      {t("easyMode.api.baseUrl")}
                    </label>
                    <input
                      type="text"
                      className="text-input"
                      value={apiBaseUrl}
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                  <div className="simple-mode-field">
                    <label>
                      {t("easyMode.api.apiKey")}
                    </label>
                    <input
                      type="password"
                      className="text-input"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                  </div>
                </div>

                <div className="simple-mode-api-model-card">
                  <div className="simple-mode-api-model-toolbar">
                    <input
                      type="text"
                      className="text-input"
                      value={apiCustomModelId}
                      onChange={(e) => setApiCustomModelId(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddCustomModel();
                        }
                      }}
                      placeholder={t("easyMode.api.customModelPlaceholder")}
                      aria-label={t("easyMode.api.customModelId")}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!apiCustomModelId.trim()}
                      onClick={handleAddCustomModel}
                    >
                      <Plus size={14} />
                      {t("easyMode.api.addModelId")}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={apiTesting || !apiBaseUrl.trim()}
                      onClick={() => void handleTestApi()}
                    >
                      {apiTesting ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
                      {apiTesting ? t("easyMode.api.fetchingModels") : t("easyMode.api.fetchModels")}
                    </button>
                  </div>

                  {displayedApiModels.length > 0 ? (
                    <div className="simple-mode-api-model-options">
                      {displayedApiModels.map((model) => {
                        const key = model.name.trim().toLowerCase();
                        const selected = apiSelectedModels.some(
                          (item) => item.name.trim().toLowerCase() === key,
                        );
                        return (
                          <label
                            className={`simple-mode-api-model-option${selected ? " selected" : ""}`}
                            key={model.name}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => handleToggleApiModel(model)}
                            />
                            <span title={model.name}>{model.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                </div>

                <div className="simple-mode-api-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={apiSaving || !apiBaseUrl.trim() || apiSelectedModels.length === 0}
                    onClick={() => void handleSaveApi()}
                  >
                    {apiSaving ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
                    保存并接入
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="simple-mode-task-footer" style={{ marginTop: 10 }}>
            <div className="simple-mode-selection">
              {hasConnectedSource ? (
                <span style={{ color: "var(--ui-accent-strong)", fontWeight: 600 }}>
                  {t("easyMode.status.connectedModels", { count: Math.max(availableModels.length, 1) })}
                </span>
              ) : (
                <span className="muted">{t("easyMode.status.noModelsYet")}</span>
              )}
            </div>

            <button
              type="button"
              className="primary-button"
              style={{ minHeight: 42, padding: "0 22px", fontSize: "15px" }}
              disabled={!hasConnectedSource}
              onClick={() => setActiveStep(2)}
            >
              {t("easyMode.navigation.next")}: 配置智能体
              <ArrowRight size={16} style={{ marginLeft: 6 }} />
            </button>
          </div>
        </section>
      ) : null}

      {/* 第二步：接入智能体 */}
      {activeStep === 2 ? (
        <section className="panel simple-mode-task">
          <AgentsPage embedded />

          <div className="simple-mode-task-footer" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setActiveStep(1)}
            >
              <ArrowLeft size={16} style={{ marginRight: 6 }} />
              {t("easyMode.navigation.back")}
            </button>

            <button
              type="button"
              className="primary-button"
              style={{ minHeight: 42, padding: "0 22px", fontSize: "15px" }}
              onClick={() => onExit?.()}
            >
              <CheckCircle2 size={16} style={{ marginRight: 6 }} />
              {t("easyMode.complete.enterApp")}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
