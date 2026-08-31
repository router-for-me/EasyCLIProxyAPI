import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  ChevronDown,
  Languages,
  LoaderCircle,
  Moon,
  Sun,
  X,
} from "lucide-react";
import appLogo from "../assets/logo.jpg";
import { useI18n, languageOptions, type AppLocale } from "../i18n";
import {
  managementApi,
  readString,
  responseList,
} from "../services/managementApi";
import {
  fetchModels,
  normalizeBaseUrl,
  type ModelOption,
  type ModelProvider,
} from "../services/modelService";
import { type AppTheme } from "../theme";
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
  theme,
  setTheme,
  locale,
  setLocale,
}: {
  onExit?: () => void;
  theme?: AppTheme;
  setTheme?: (theme: AppTheme) => void;
  locale?: AppLocale;
  setLocale?: (locale: AppLocale) => void;
}) {
  const { t, locale: currentLocale, setLocale: setI18nLocale } = useI18n();

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
  const [apiTestError, setApiTestError] = useState("");
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaveNotice, setApiSaveNotice] = useState<string | null>(null);

  const [guideChoice, setGuideChoice] = useState<AuthMethod | null>(null);
  const [guideOAuthProvider, setGuideOAuthProvider] = useState<OAuthProviderId | null>(null);
  const [guideOAuthCompleted, setGuideOAuthCompleted] = useState(false);
  const [guideApiSaved, setGuideApiSaved] = useState(false);
  const [guideApiFormatSelected, setGuideApiFormatSelected] = useState(false);
  const [guideApiBaseEdited, setGuideApiBaseEdited] = useState(false);
  const [guideApiKeyEdited, setGuideApiKeyEdited] = useState(false);
  const [guideApiModelsFetched, setGuideApiModelsFetched] = useState(false);
  const [guideApiModelSelected, setGuideApiModelSelected] = useState(false);
  const [guideAgentConfigured, setGuideAgentConfigured] = useState(false);

  // 新手聚焦指导状态（默认关闭，点击开启）
  const [guideActive, setGuideActive] = useState(false);
  const [guideStep, setGuideStep] = useState<number>(1);
  const [spotlightRect, setSpotlightRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const guideTooltipRef = useRef<HTMLElement | null>(null);
  const [guideCardPosition, setGuideCardPosition] = useState<{ top: number; left: number } | null>(null);
  const [langMenuOpen, setLangMenuOpen] = useState(false);

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
      }
      setApiCounts(counts);
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
  }, [refreshSourceStatus]);

  useEffect(() => {
    if (!oauthNotice) return undefined;
    const timer = window.setTimeout(() => {
      setOauthNotice(null);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [oauthNotice]);

  useEffect(() => {
    if (!apiSaveNotice) return undefined;
    const timer = window.setTimeout(() => {
      setApiSaveNotice(null);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [apiSaveNotice]);

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
  const connectedSourceCount = totalLoggedInOAuth + totalApiProviders;
  const guideConnectedSourceCount = Math.max(connectedSourceCount, guideOAuthCompleted || guideApiSaved ? 1 : 0);
  const setupStepStatus = t("easyMode.steps.current", {
    current: activeStep,
    total: 2,
  });

  const handleAuthMethodSelect = (method: AuthMethod) => {
    setAuthMethod(method);
    if (guideActive && guideStep === 1) setGuideChoice(method);
  };

  const handleStartOAuth = async (provider: OAuthProviderId) => {
    if (guideActive && guideStep === 2) {
      setGuideOAuthProvider(provider);
      setGuideOAuthCompleted(false);
    }
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
            setGuideOAuthCompleted(true);
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
    if (guideActive && guideStep === 2) {
      setGuideApiFormatSelected(true);
      setGuideApiBaseEdited(false);
      setGuideApiKeyEdited(false);
    }
    const opt = apiSectionOptions.find((o) => o.id === sec);
    if (opt) setApiBaseUrl(opt.defaultBaseUrl);
    setApiTestedModels([]);
    setApiSelectedModels([]);
    setApiTestError("");
    setApiSaveNotice(null);
    setGuideApiSaved(false);
    setGuideApiModelsFetched(false);
    setGuideApiModelSelected(false);
  };

  const handleTestApi = async () => {
    if (!apiBaseUrl.trim()) {
      setApiTestError("请先填写 API Base URL");
      return;
    }
    if (!apiKey.trim()) {
      setApiTestError("请先填写 API Key");
      return;
    }
    setApiTesting(true);
    setApiTestError("");
    setApiTestedModels([]);
    setApiSelectedModels([]);
    setGuideApiSaved(false);
    setGuideApiModelsFetched(false);
    setGuideApiModelSelected(false);

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
        setApiSelectedModels([]);
        setGuideApiModelsFetched(true);
      } else {
        setApiTestError("未获取到任何模型，请检查 API Base URL 与密钥");
      }
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiTesting(false);
    }
  };

  const handleToggleApiModel = (model: ModelOption) => {
    setGuideApiSaved(false);
    setGuideApiModelSelected(true);
    const key = model.name.trim().toLowerCase();
    if (!key) return;
    setApiSelectedModels((current) => {
      const selected = current.some((item) => item.name.trim().toLowerCase() === key);
      return selected
        ? current.filter((item) => item.name.trim().toLowerCase() !== key)
        : [...current, model];
    });
  };

  const handleSaveApi = async () => {
    if (!apiBaseUrl.trim()) {
      setApiTestError("请先填写 API Base URL");
      return;
    }
    if (!apiKey.trim()) {
      setApiTestError("请先填写 API Key");
      return;
    }
    if (apiSelectedModels.length === 0) {
      setApiTestError(t("easyMode.api.modelRequired"));
      return;
    }
    if (guideActive && guideStep === 2 && authMethod === "api") {
      if (!guideApiFormatSelected || !guideApiBaseEdited || !guideApiKeyEdited || !guideApiModelsFetched || !guideApiModelSelected) {
        setApiTestError("请按引导完成接口格式、地址、密钥和模型选择后再保存");
        return;
      }
    }
    setApiSaving(true);
    setApiSaveNotice(null);
    setApiTestError("");
    setGuideApiSaved(false);

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
      setGuideApiSaved(true);
      void refreshSourceStatus();
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiSaving(false);
    }
  };

  // 获取当前聚焦点元素 ID (4 个稳定步骤)
  const currentTargetId = (() => {
    if (!guideActive) return null;
    if (activeStep === 1) {
      if (guideStep === 1) return "easy-guide-choice-grid";
      if (guideStep === 2) return authMethod === "oauth" ? "easy-guide-oauth-box" : "easy-guide-api-box";
      if (guideStep >= 3) return "easy-guide-footer-action";
    } else if (activeStep === 2) {
      return "easy-guide-agents-panel";
    }
    return null;
  })();

  // 计算聚光灯位置
  const updateSpotlightPosition = useCallback(() => {
    if (!guideActive || !currentTargetId) {
      setSpotlightRect(null);
      return;
    }

    const el = document.getElementById(currentTargetId);
    if (el) {
      const rect = el.getBoundingClientRect();
      setSpotlightRect({
        top: Math.max(0, rect.top),
        left: Math.max(0, rect.left),
        width: rect.width,
        height: rect.height,
      });
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      setSpotlightRect(null);
    }
  }, [guideActive, currentTargetId]);

  useEffect(() => {
    const timer = setTimeout(updateSpotlightPosition, 100);
    window.addEventListener("resize", updateSpotlightPosition);
    window.addEventListener("scroll", updateSpotlightPosition, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", updateSpotlightPosition);
      window.removeEventListener("scroll", updateSpotlightPosition, true);
    };
  }, [updateSpotlightPosition]);

  useEffect(() => {
    setGuideCardPosition(null);
  }, [currentTargetId]);

  useLayoutEffect(() => {
    if (!guideActive || !spotlightRect || !guideTooltipRef.current) {
      setGuideCardPosition(null);
      return;
    }

    const cardRect = guideTooltipRef.current.getBoundingClientRect();
    const viewportPadding = 16;
    const gap = 18;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const cardWidth = cardRect.width;
    const cardHeight = cardRect.height;
    const targetTop = spotlightRect.top;
    const targetBottom = spotlightRect.top + spotlightRect.height;
    const targetRight = spotlightRect.left + spotlightRect.width;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const centeredLeft = clamp(spotlightRect.left, viewportPadding, viewportWidth - cardWidth - viewportPadding);
    const belowTop = targetBottom + gap;
    const aboveTop = targetTop - cardHeight - gap;
    let top: number;
    let left = centeredLeft;

    if (belowTop + cardHeight <= viewportHeight - viewportPadding) {
      top = belowTop;
    } else if (aboveTop >= viewportPadding) {
      top = aboveTop;
    } else if (targetRight + gap + cardWidth <= viewportWidth - viewportPadding) {
      left = targetRight + gap;
      top = clamp(targetTop, viewportPadding, viewportHeight - cardHeight - viewportPadding);
    } else if (spotlightRect.left - gap - cardWidth >= viewportPadding) {
      left = spotlightRect.left - cardWidth - gap;
      top = clamp(targetTop, viewportPadding, viewportHeight - cardHeight - viewportPadding);
    } else {
      top = clamp(belowTop, viewportPadding, viewportHeight - cardHeight - viewportPadding);
    }

    setGuideCardPosition({ top, left });
  }, [
    authMethod,
    currentTargetId,
    guideActive,
    guideAgentConfigured,
    guideApiSaved,
    guideOAuthCompleted,
    guideStep,
    spotlightRect,
  ]);

  const guideCanAdvance = guideStep === 1
    ? guideChoice !== null
    : guideStep === 2
      ? authMethod === "oauth"
        ? guideOAuthProvider !== null && guideOAuthCompleted
        : guideApiFormatSelected && guideApiBaseEdited && guideApiKeyEdited && guideApiModelsFetched && guideApiModelSelected && guideApiSaved
      : guideStep === 3
        ? hasConnectedSource || guideOAuthCompleted || guideApiSaved
        : guideAgentConfigured;

  // 指引步骤控制
  const handleNextGuideStep = () => {
    if (!guideCanAdvance) return;
    if (guideStep === 1) {
      setGuideStep(2);
    } else if (guideStep === 2) {
      setGuideStep(3);
    } else if (guideStep === 3) {
      setActiveStep(2);
      setGuideStep(4);
    } else if (guideStep === 4) {
      setGuideActive(false);
    }
  };

  const handlePrevGuideStep = () => {
    if (guideStep === 4) {
      setActiveStep(1);
      setGuideStep(3);
    } else if (guideStep > 1) {
      setGuideStep(guideStep - 1);
    }
  };

  const handleGuideToggle = () => {
    if (guideActive) {
      setGuideActive(false);
      return;
    }
    setActiveStep(1);
    setGuideStep(1);
    setGuideChoice(null);
    setGuideOAuthProvider(null);
    setGuideOAuthCompleted(false);
    setGuideApiSaved(false);
    setGuideApiFormatSelected(false);
    setGuideApiBaseEdited(false);
    setGuideApiKeyEdited(false);
    setGuideApiModelsFetched(false);
    setGuideApiModelSelected(false);
    setGuideAgentConfigured(false);
    setGuideActive(true);
  };

  const currentActiveLang = languageOptions.find((opt) => opt.value === (locale || currentLocale)) || languageOptions[0];

  return (
    <section className="page simple-mode-page simple-mode-expanded">
      {/* 全灰色聚焦蒙层 (Dimmed Backdrop) */}
      {guideActive ? <div className="guide-dimmed-overlay" /> : null}

      {/* 顶部全宽导航栏 */}
      <header className="simple-mode-topbar">
        <div className="simple-mode-topbar-left">
          <div className="simple-mode-brand">
            <img src={appLogo} alt="" className="brand-mark brand-logo" />
            <div className="simple-mode-brand-text">
              <div className="simple-mode-brand-title">
                <strong>EasyCLIProxyAPI</strong>
                <span className="simple-mode-badge">新手模式</span>
              </div>
              <span className="simple-mode-brand-sub">极简智能体与模型接入向导</span>
            </div>
          </div>
        </div>

        <div className="simple-mode-topbar-right">
          {/* 新手聚焦指导开关 */}
          <button
            type="button"
            className={`simple-mode-guide-toggle${guideActive ? " active" : ""}`}
            title={guideActive ? "点击关闭操作指引" : "点击开启操作指引"}
            onClick={() => {
              handleGuideToggle();
            }}
          >
            <span>{guideActive ? "操作指引 (进行中)" : "操作指引"}</span>
          </button>

          {/* 主题切换 */}
          {setTheme ? (
            <div className="simple-mode-theme-group">
              <button
                type="button"
                className={theme === "light" ? "active" : ""}
                title="明亮主题"
                onClick={() => setTheme("light")}
              >
                <Sun size={15} />
              </button>
              <button
                type="button"
                className={theme === "dark" ? "active" : ""}
                title="暗色主题"
                onClick={() => setTheme("dark")}
              >
                <Moon size={15} />
              </button>
            </div>
          ) : null}

          {/* 语言选择 */}
          <div className="simple-mode-lang-dropdown">
            <button
              type="button"
              className="simple-mode-lang-btn"
              onClick={() => setLangMenuOpen(!langMenuOpen)}
              title="切换语言"
            >
              <Languages size={15} />
              <span>{currentActiveLang.nativeLabel}</span>
              <ChevronDown size={13} />
            </button>
            {langMenuOpen ? (
              <div className="simple-mode-lang-menu">
                {languageOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={opt.value === (locale || currentLocale) ? "selected" : ""}
                    onClick={() => {
                      if (setLocale) setLocale(opt.value);
                      else setI18nLocale(opt.value);
                      setLangMenuOpen(false);
                    }}
                  >
                    <span>{opt.nativeLabel}</span>
                    {opt.value === (locale || currentLocale) ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* 退出新手模式返回常规控制台 */}
          <button
            type="button"
            className="secondary-button simple-mode-exit-btn"
            title="返回常规控制台"
            onClick={() => onExit?.()}
          >
            <span>退出新手模式</span>
          </button>
        </div>
      </header>

      {/* 步骤条进度指示器 */}
      <nav className="simple-mode-step-status" aria-label={t("easyMode.steps.label")}>
        <div className="simple-mode-step-status-heading">
          <span>{t("easyMode.steps.label")}</span>
          <strong>{setupStepStatus}</strong>
        </div>
        <div className="simple-mode-step-status-track">
          <div
            className={`simple-mode-step-status-item${activeStep === 1 ? " active" : " complete"}`}
            aria-current={activeStep === 1 ? "step" : undefined}
            onClick={() => {
              if (guideActive) return;
              setActiveStep(1);
            }}
            style={{ cursor: guideActive ? "default" : "pointer" }}
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
            onClick={() => {
              if (!guideActive && hasConnectedSource) {
                setActiveStep(2);
              }
            }}
            style={{ cursor: !guideActive && hasConnectedSource ? "pointer" : "default" }}
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

          {/* 连接方式选择卡片 */}
          <div
            id="easy-guide-choice-grid"
            className={`simple-mode-choice-grid${guideActive && guideStep === 1 ? " guide-focus-highlight" : ""}`}
          >
            <button
              type="button"
              className={`simple-mode-choice${authMethod === "oauth" ? " selected" : ""}`}
              aria-pressed={authMethod === "oauth"}
              onClick={() => handleAuthMethodSelect("oauth")}
              disabled={guideActive && guideStep !== 1}
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
              onClick={() => handleAuthMethodSelect("api")}
              disabled={guideActive && guideStep !== 1}
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

          {/* OAuth 平台列表 */}
          {authMethod === "oauth" ? (
            <div
              id="easy-guide-oauth-box"
              className={`simple-mode-embedded-box${guideActive && guideStep === 2 ? " guide-focus-highlight" : ""}`}
            >
              {oauthNotice ? (
                <div className={`config-toast ${oauthNotice.tone}`}>
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
                      className={`panel simple-mode-provider-card${loggedIn ? " connected" : ""}`}
                    >
                      <div className="simple-mode-provider-card-head">
                        <div className="simple-mode-provider-logo">
                          <img src={provider.icon} alt="" />
                        </div>
                        <div className="simple-mode-provider-copy">
                          <strong>{provider.name}</strong>
                          <span>{provider.description}</span>
                        </div>
                      </div>

                      <div className="simple-mode-provider-card-foot">
                        {loggedIn ? (
                          <span className="state-pill success" style={{ fontSize: "12px" }}>
                            <Check size={12} style={{ marginRight: 4 }} />
                            {t("easyMode.oauth.loggedIn")}
                          </span>
                        ) : (
                          <span className="state-pill neutral" style={{ fontSize: "12px" }}>未登录</span>
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

          {/* API 接入表单 */}
          {authMethod === "api" ? (
            <div
              id="easy-guide-api-box"
              className={`simple-mode-embedded-box${guideActive && guideStep === 2 ? " guide-focus-highlight" : ""}`}
            >
              {apiSaveNotice ? (
                <div className="config-toast success">
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
                {/* 平台格式切换 */}
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
                  <label>{t("easyMode.api.name")}</label>
                  <input
                    type="text"
                    className="text-input"
                    value={apiRemark}
                    onChange={(e) => { setApiRemark(e.target.value); setGuideApiSaved(false); }}
                    placeholder="例如：主力 DeepSeek V3、中转 API"
                  />
                </div>

                <div className="simple-mode-api-fields">
                  <div className="simple-mode-field">
                    <label>{t("easyMode.api.baseUrl")}</label>
                    <input
                      type="text"
                      className="text-input"
                      value={apiBaseUrl}
                      onChange={(e) => { setApiBaseUrl(e.target.value); setGuideApiBaseEdited(true); setGuideApiSaved(false); }}
                      placeholder="https://..."
                    />
                  </div>
                  <div className="simple-mode-field">
                    <label>{t("easyMode.api.apiKey")}</label>
                    <input
                      type="password"
                      className="text-input"
                      value={apiKey}
                      onChange={(e) => { setApiKey(e.target.value); setGuideApiKeyEdited(true); setGuideApiSaved(false); }}
                      placeholder="sk-..."
                    />
                  </div>
                </div>

                {/* 模型拉取与选择 */}
                <div className="simple-mode-api-model-card">
                  {apiTestedModels.length === 0 ? (
                    <div className="simple-mode-api-model-fetch">
                      <button
                        type="button"
                        className="secondary-button simple-mode-api-fetch-button"
                        disabled={apiTesting || !apiBaseUrl.trim() || !apiKey.trim()}
                        onClick={() => void handleTestApi()}
                      >
                        {apiTesting ? (
                          <>
                            <LoaderCircle size={14} className="spin" style={{ marginRight: 6 }} />
                            {t("easyMode.api.fetchingModels")}
                          </>
                        ) : (
                          t("easyMode.api.fetchModels")
                        )}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="simple-mode-api-model-heading">
                        <strong>{t("easyMode.api.modelListTitle")}</strong>
                      </div>

                      <div className="simple-mode-api-model-selection">
                        <div className="simple-mode-api-model-selection-heading">
                          <span>{t("easyMode.api.modelListHint")}</span>
                        </div>
                        <div className="simple-mode-api-model-options">
                          {apiTestedModels.map((model) => {
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
                      </div>

                      <div className="simple-mode-api-actions">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={apiSaving || !apiBaseUrl.trim() || !apiKey.trim() || apiSelectedModels.length === 0}
                          onClick={() => void handleSaveApi()}
                        >
                          保存并接入
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* 第一步底部操作栏 */}
          <div
            id="easy-guide-footer-action"
            className={`simple-mode-task-footer${guideActive && guideStep === 3 ? " guide-focus-highlight" : ""}`}
            style={{ marginTop: 10 }}
          >
            <div className="simple-mode-selection">
              {hasConnectedSource ? (
                <span style={{ color: "var(--ui-accent-strong)", fontWeight: 600 }}>
                  {t("easyMode.status.connectedModels", { count: connectedSourceCount })}
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
              onClick={() => {
                setActiveStep(2);
                if (guideActive) setGuideStep(4);
              }}
            >
              {t("easyMode.navigation.next")}: 配置智能体
              <ArrowRight size={16} style={{ marginLeft: 6 }} />
            </button>
          </div>
        </section>
      ) : null}

      {/* 第二步：接入智能体 */}
      {activeStep === 2 ? (
        <section
          id="easy-guide-agents-panel"
          className={`panel simple-mode-task${guideActive && guideStep === 4 ? " guide-focus-highlight" : ""}`}
        >
          <AgentsPage embedded onConfigurationApplied={() => setGuideAgentConfigured(true)} />

          <div className="simple-mode-task-footer" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setActiveStep(1);
                if (guideActive) setGuideStep(3);
              }}
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

      {/* 悬浮指导卡片 */}
      {guideActive && spotlightRect ? (
        <aside
          ref={guideTooltipRef}
          className="guide-interactive-card"
          style={{
            top: guideCardPosition ? `${guideCardPosition.top}px` : "0px",
            left: guideCardPosition ? `${guideCardPosition.left}px` : "0px",
            visibility: guideCardPosition ? "visible" : "hidden",
          }}
        >
          <div className="guide-tooltip-header">
            <div className="guide-tooltip-badge">
              <span>
                {guideStep === 1 && "步骤 1/4 · 选择连接方式"}
                {guideStep === 2 && (authMethod === "oauth" ? "步骤 2/4 · 授权登录账号" : "步骤 2/4 · 填写 API 与接入")}
                {guideStep === 3 && "步骤 3/4 · 确认接入来源并进入下一步"}
                {guideStep === 4 && "步骤 4/4 · 选择客户端并应用配置"}
              </span>
            </div>

            <button
              type="button"
              className="guide-tooltip-close"
              title="关闭指导"
              onClick={() => setGuideActive(false)}
            >
              <X size={15} />
            </button>
          </div>

          <div className="guide-tooltip-body">
            {guideStep === 1 ? (
              <>
                <h4>步骤 1：选择接入方式</h4>
                <p>
                  <strong>OAuth 授权登录</strong>：适用于页面列出的 OAuth 平台。<br />
                  <strong>API 密钥接入</strong>：适用于你已有 API Base URL 和 API Key 的服务或中转平台。
                </p>
                <div className="guide-tooltip-tip">
                  {guideChoice ? "选择接入方式后，请点击『下一步』继续。" : "请点击上方任一接入方式；选择完成后才能继续。"}
                </div>
              </>
            ) : null}

            {guideStep === 2 && authMethod === "oauth" ? (
              <>
                <h4>步骤 2：完成 OAuth 授权</h4>
                <p>
                  请选择一个平台，点击它右侧的 <strong>『开始登录』</strong> 或 <strong>『重新登录』</strong>，并在浏览器中完成授权。<br />
                  返回应用后，平台显示为 <strong>『已登录』</strong> 才算完成本步骤；未成功授权不能继续。
                </p>
                <div className="guide-tooltip-tip">
                  {guideOAuthCompleted && guideOAuthProvider ? (
                    <strong>{oauthProviders.find((provider) => provider.id === guideOAuthProvider)?.name} 已授权成功，请点击『下一步』。</strong>
                  ) : (
                    "请先点击一个平台的登录按钮，并等待授权结果返回。"
                  )}
                </div>
              </>
            ) : null}

            {guideStep === 2 && authMethod === "api" ? (
              <>
                <h4>步骤 2：填写并保存 API 接入</h4>
                <p>
                  1. 选择接口格式。<br />
                  2. 填写 <strong>API Base URL</strong> 和 <strong>API Key</strong>。<br />
                  3. 点击 <strong>『获取模型列表』</strong>，至少勾选一个模型，再点击 <strong>『保存并接入』</strong>。
                </p>
                <div className="guide-tooltip-tip">
                  {guideApiSaved ? (
                    <strong>API 接入已保存成功，请点击『下一步』。</strong>
                  ) : !guideApiFormatSelected ? (
                    "请先点击一个接口格式，再填写接入信息。"
                  ) : !guideApiBaseEdited || !guideApiKeyEdited ? (
                    "请重新填写 Base URL 和 API Key；填写完成后才能获取模型。"
                  ) : !guideApiModelsFetched || apiTestedModels.length === 0 ? (
                    "请点击『获取模型列表』并等待结果返回。"
                  ) : !guideApiModelSelected || apiSelectedModels.length === 0 ? (
                    "已获取模型，请至少勾选一个模型后保存。"
                  ) : (
                    <span>已完成填写并选中 {apiSelectedModels.length} 个模型，请点击『保存并接入』。</span>
                  )}
                </div>
              </>
            ) : null}

            {guideStep === 3 ? (
              <>
                <h4>步骤 3：确认接入来源</h4>
                <p>
                  当前已确认 <strong>{guideConnectedSourceCount}</strong> 个接入来源。这里表示账号或 API 配置已接入，不代表客户端已经完成配置。<br />
                  请点击下方高亮的 <strong>『下一步：配置智能体』</strong>，进入客户端选择和模型绑定。
                </p>
                <div className="guide-tooltip-tip">
                  {guideCanAdvance ? "接入来源已确认，请点击『下一步：配置智能体』。" : "请先完成上一步的授权或 API 保存。"}
                </div>
              </>
            ) : null}

            {guideStep === 4 ? (
              <>
                <h4>步骤 4：选择客户端并应用配置</h4>
                <p>
                  左侧列表会显示客户端的检测状态。请选择一个显示为 <strong>『已检测到』</strong> 且支持当前系统的客户端，再在右侧 <strong>『使用模型』</strong> 中选择模型。<br />
                  非 Pi 客户端点击实际显示的 <strong>『应用配置』</strong> 或 <strong>『更新配置』</strong>；Pi 客户端点击 <strong>『安装提供方』</strong> 或 <strong>『修复提供方』</strong>。成功后才能完成指引。
                </p>
                <div className="guide-tooltip-tip">
                  {guideAgentConfigured ? "配置已成功应用。你还可以点击『完成并进入控制台』返回控制台；启动客户端需要另行点击启动按钮。" : "请先选择已检测到的客户端和模型，再点击对应的配置按钮并等待成功结果。"}
                </div>
              </>
            ) : null}
          </div>

          <div className="guide-tooltip-footer">
            <div className="guide-tooltip-step-dots">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={`guide-step-dot${guideStep === step ? " active" : ""}`}
                  aria-hidden="true"
                />
              ))}
            </div>

            <div className="guide-tooltip-actions">
              {guideStep > 1 ? (
                <button
                  type="button"
                  className="secondary-button guide-btn-sm"
                  onClick={handlePrevGuideStep}
                >
                  上一步
                </button>
              ) : null}

              <button
                type="button"
                className="primary-button guide-btn-sm"
                onClick={handleNextGuideStep}
                disabled={!guideCanAdvance}
              >
                {guideStep === 4 ? "完成指引" : "下一步"}
              </button>
            </div>
          </div>
        </aside>
      ) : null}
    </section>
  );
}
