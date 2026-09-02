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
import { useI18n, languageOptions, type AppLocale, type MessageKey } from "../i18n";
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
  descriptionKey: MessageKey;
};

const oauthProviders: OAuthProviderInfo[] = [
  { id: "codex", name: "Codex OAuth", icon: codexIcon, description: "OpenAI / ChatGPT account authorization", descriptionKey: "easyMode.oauth.descCodex" },
  { id: "claude", name: "Claude OAuth", icon: claudeIcon, description: "Anthropic / Claude account authorization", descriptionKey: "easyMode.oauth.descClaude" },
  { id: "antigravity", name: "Antigravity OAuth", icon: antigravityIcon, description: "Antigravity account authorization", descriptionKey: "easyMode.oauth.descAntigravity" },
  { id: "kimi", name: "Kimi OAuth", icon: kimiIcon, description: "Moonshot / Kimi account authorization", descriptionKey: "easyMode.oauth.descKimi" },
  { id: "xai", name: "xAI OAuth", icon: grokIcon, description: "xAI / Grok account authorization", descriptionKey: "easyMode.oauth.descXai" },
];

type ApiSection = "openai-compatibility" | "deepseek" | "claude" | "gemini" | "codex";
type ApiManagementSection = "openai-compatibility" | "claude-api-key" | "codex-api-key" | "gemini-api-key";

type ApiSectionOption = {
  id: ApiSection;
  managementSection: ApiManagementSection;
  name: string;
  nameKey?: MessageKey;
  provider: ModelProvider;
  defaultBaseUrl: string;
  icon: string;
};

const apiSectionOptions: ApiSectionOption[] = [
  { id: "openai-compatibility", managementSection: "openai-compatibility", name: "OpenAI Format", nameKey: "easyMode.api.formatOpenAi", provider: "openai", defaultBaseUrl: "", icon: openaiIcon },
  { id: "claude", managementSection: "claude-api-key", name: "Anthropic Format", nameKey: "easyMode.api.formatClaude", provider: "claude", defaultBaseUrl: "", icon: claudeIcon },
  { id: "codex", managementSection: "codex-api-key", name: "Codex API", provider: "codex", defaultBaseUrl: "", icon: codexIcon },
  { id: "gemini", managementSection: "gemini-api-key", name: "Gemini Format", nameKey: "easyMode.api.formatGemini", provider: "gemini", defaultBaseUrl: "", icon: geminiIcon },
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
  const [guideApiModelsFetched, setGuideApiModelsFetched] = useState(false);
  const [guideAgentConfigured, setGuideAgentConfigured] = useState(false);

  // Guided walkthrough state (off by default, click to enable)
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
          message: t("easyMode.oauth.errorGetStatus"),
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
              message: t("easyMode.oauth.loginSuccess"),
            });
            setGuideOAuthCompleted(true);
            void refreshSourceStatus();
          } else if (status === "error") {
            if (oauthPollTimer.current) window.clearInterval(oauthPollTimer.current);
            setOauthLoggingIn(null);
            setOauthNotice({
              tone: "error",
              message: pollRes.error ? t("easyMode.oauth.errorWithDetail", { error: pollRes.error }) : t("easyMode.oauth.errorRetry"),
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
    setApiTestError("");
    setApiSaveNotice(null);
    setGuideApiSaved(false);
    setGuideApiModelsFetched(false);
  };

  const handleTestApi = async () => {
    if (!apiBaseUrl.trim()) {
      setApiTestError(t("easyMode.api.errorBaseUrl"));
      return;
    }
    if (!apiKey.trim()) {
      setApiTestError(t("easyMode.api.errorApiKey"));
      return;
    }
    setApiTesting(true);
    setApiTestError("");
    setApiTestedModels([]);
    setApiSelectedModels([]);
    setGuideApiSaved(false);
    setGuideApiModelsFetched(false);

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
        setApiSelectedModels(models);
        setGuideApiModelsFetched(true);
      } else {
        setApiTestError(t("easyMode.api.errorNoModels"));
      }
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiTesting(false);
    }
  };

  const handleToggleApiModel = (model: ModelOption) => {
    setGuideApiSaved(false);
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
      setApiTestError(t("easyMode.api.errorBaseUrl"));
      return;
    }
    if (!apiKey.trim()) {
      setApiTestError(t("easyMode.api.errorApiKey"));
      return;
    }
    if (apiSelectedModels.length === 0) {
      setApiTestError(t("easyMode.api.modelRequired"));
      return;
    }
    if (guideActive && guideStep === 2 && authMethod === "api" && !guideApiModelsFetched) {
      setApiTestError(t("easyMode.api.errorFetchModelsFirst"));
      return;
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
      setApiSaveNotice(t("easyMode.api.savedNotice"));
      setGuideApiSaved(true);
      void refreshSourceStatus();
    } catch (err) {
      setApiTestError(String(err));
    } finally {
      setApiSaving(false);
    }
  };

  // Current spotlight target element ID (4 stable steps)
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

  // Calculate spotlight position
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
        : guideApiSaved
      : guideStep === 3
        ? hasConnectedSource || guideOAuthCompleted || guideApiSaved
        : guideAgentConfigured;

  // Guide step controls
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
    setGuideApiModelsFetched(false);
    setGuideAgentConfigured(false);
    setGuideActive(true);
  };

  const currentActiveLang = languageOptions.find((opt) => opt.value === (locale || currentLocale)) || languageOptions[0];

  return (
    <section className="page simple-mode-page simple-mode-expanded">
      {/* Dimmed backdrop overlay */}
      {guideActive ? <div className="guide-dimmed-overlay" /> : null}

      {/* Full-width top navigation bar */}
      <header className="simple-mode-topbar">
        <div className="simple-mode-topbar-left">
          <div className="simple-mode-brand">
            <img src={appLogo} alt="" className="brand-mark brand-logo" />
            <div className="simple-mode-brand-text">
              <div className="simple-mode-brand-title">
                <strong>EasyCLIProxyAPI</strong>
                <span className="simple-mode-badge">{t("app.nav.easy")}</span>
              </div>
              <span className="simple-mode-brand-sub">{t("easyMode.subtitle")}</span>
            </div>
          </div>
          {/* Guided setup toggle */}
          <button
            type="button"
            className={`simple-mode-guide-toggle simple-mode-highlight-button${guideActive ? " active" : ""}`}
            title={guideActive ? t("easyMode.guide.tooltipClose") : t("easyMode.guide.tooltipOpen")}
            onClick={() => {
              handleGuideToggle();
            }}
          >
            <span>{guideActive ? t("easyMode.guide.buttonActive") : t("easyMode.guide.button")}</span>
          </button>
        </div>

        <div className="simple-mode-topbar-right">
          {/* Theme toggle */}
          {setTheme ? (
            <div className="simple-mode-theme-group">
              <button
                type="button"
                className={theme === "light" ? "active" : ""}
                title={t("app.theme.switchToLight")}
                onClick={() => setTheme("light")}
              >
                <Sun size={15} />
              </button>
              <button
                type="button"
                className={theme === "dark" ? "active" : ""}
                title={t("app.theme.switchToDark")}
                onClick={() => setTheme("dark")}
              >
                <Moon size={15} />
              </button>
            </div>
          ) : null}

          {/* Language selection */}
          <div className="simple-mode-lang-dropdown">
            <button
              type="button"
              className="simple-mode-lang-btn"
              onClick={() => setLangMenuOpen(!langMenuOpen)}
              title={t("app.language")}
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

          {/* Exit beginner mode and return to standard dashboard */}
          <button
            type="button"
            className="secondary-button simple-mode-exit-btn simple-mode-highlight-button"
            title={t("easyMode.exit.tooltip")}
            onClick={() => onExit?.()}
          >
            <span>{t("easyMode.exit.button")}</span>
          </button>
        </div>
      </header>

      {/* Step status progress indicator */}
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

      {/* Step 1: Connect models */}
      {activeStep === 1 ? (
        <section className="panel simple-mode-task">
          <div className="simple-mode-task-heading">
            <div>
              <h2>{t("easyMode.overview.providerTitle")}</h2>
              <p>{t("easyMode.setup.providerDescription")}</p>
            </div>
          </div>

          {/* Connection method choice cards */}
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
                      {t("easyMode.oauth.loggedInCount", { count: totalLoggedInOAuth })}
                    </span>
                  ) : (
                    <span className="state-pill neutral" style={{ fontSize: "12px" }}>{t("easyMode.oauth.recommended")}</span>
                  )}
                </div>
              </div>
              <span>{t("easyMode.oauth.description")}</span>
              <small>{t("easyMode.oauth.supportedProviders")}</small>
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
                      {t("easyMode.api.connectedCount", { count: totalApiProviders })}
                    </span>
                  ) : null}
                </div>
              </div>
              <span>{t("easyMode.api.description")}</span>
              <small>{t("easyMode.api.supportedProviders")}</small>
            </button>
          </div>

          {/* OAuth platform list */}
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
                          <span>{provider.descriptionKey ? t(provider.descriptionKey) : provider.description}</span>
                        </div>
                      </div>

                      <div className="simple-mode-provider-card-foot">
                        {loggedIn ? (
                          <span className="state-pill success" style={{ fontSize: "12px" }}>
                            <Check size={12} style={{ marginRight: 4 }} />
                            {t("easyMode.oauth.loggedIn")}
                          </span>
                        ) : (
                          <span className="state-pill neutral" style={{ fontSize: "12px" }}>{t("easyMode.oauth.notLoggedIn")}</span>
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
                            t("easyMode.oauth.startLogin")
                          )}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* API connection form */}
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
                {/* Platform format toggle */}
                <div className="simple-mode-api-platforms">
                  {apiSectionOptions.map((opt) => (
                    <button
                      type="button"
                      key={opt.id}
                      className={`secondary-button simple-mode-api-platform${selectedApiSection === opt.id ? " active" : ""}`}
                      onClick={() => handleApiSectionChange(opt.id)}
                    >
                      <img className="simple-mode-api-platform-icon" src={opt.icon} alt="" />
                      {opt.nameKey ? t(opt.nameKey) : opt.name}
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
                    placeholder={t("easyMode.api.remarkPlaceholder")}
                  />
                </div>

                <div className="simple-mode-api-fields">
                  <div className="simple-mode-field">
                    <label>{t("easyMode.api.baseUrl")}</label>
                    <input
                      type="text"
                      className="text-input"
                      value={apiBaseUrl}
                      onChange={(e) => { setApiBaseUrl(e.target.value); setGuideApiSaved(false); }}
                      placeholder="https://..."
                    />
                  </div>
                  <div className="simple-mode-field">
                    <label>{t("easyMode.api.apiKey")}</label>
                    <input
                      type="password"
                      className="text-input"
                      value={apiKey}
                      onChange={(e) => { setApiKey(e.target.value); setGuideApiSaved(false); }}
                      placeholder="sk-..."
                    />
                  </div>
                </div>

                {/* Model discovery and selection */}
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
                          {t("easyMode.api.saveAndConnect")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* Step 1 footer actions */}
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
              {t("easyMode.navigation.next")}: {t("easyMode.steps.configureAgent")}
              <ArrowRight size={16} style={{ marginLeft: 6 }} />
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 2: Connect agents */}
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

          </div>
        </section>
      ) : null}

      {/* Floating interactive guide card */}
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
                {guideStep === 1 && t("easyMode.guide.badgeStep1")}
                {guideStep === 2 && (authMethod === "oauth" ? t("easyMode.guide.badgeStep2OAuth") : t("easyMode.guide.badgeStep2Api"))}
                {guideStep === 3 && t("easyMode.guide.badgeStep3")}
                {guideStep === 4 && t("easyMode.guide.badgeStep4")}
              </span>
            </div>

            <button
              type="button"
              className="guide-tooltip-close"
              title={t("easyMode.guide.closeTooltip")}
              onClick={() => setGuideActive(false)}
            >
              <X size={15} />
            </button>
          </div>

          <div className="guide-tooltip-body">
            {guideStep === 1 ? (
              <>
                <h4>{t("easyMode.guide.step1.heading")}</h4>
                <p>
                  <strong>{t("easyMode.oauth.title")}</strong>：{t("easyMode.guide.step1.oauthDesc")}<br />
                  <strong>{t("easyMode.api.title")}</strong>：{t("easyMode.guide.step1.apiDesc")}
                </p>
                <div className="guide-tooltip-tip">
                  {guideChoice ? t("easyMode.guide.step1.tipSelected") : t("easyMode.guide.step1.tipUnselected")}
                </div>
              </>
            ) : null}

            {guideStep === 2 && authMethod === "oauth" ? (
              <>
                <h4>{t("easyMode.guide.step2OAuth.heading")}</h4>
                <p>
                  {t("easyMode.guide.step2OAuth.desc1")}<br />
                  {t("easyMode.guide.step2OAuth.desc2")}
                </p>
                <div className="guide-tooltip-tip">
                  {guideOAuthCompleted && guideOAuthProvider ? (
                    <strong>{t("easyMode.guide.step2OAuth.tipSuccess", { provider: oauthProviders.find((provider) => provider.id === guideOAuthProvider)?.name ?? "" })}</strong>
                  ) : (
                    t("easyMode.guide.step2OAuth.tipPending")
                  )}
                </div>
              </>
            ) : null}

            {guideStep === 2 && authMethod === "api" ? (
              <>
                <h4>{t("easyMode.guide.step2Api.heading")}</h4>
                <p>
                  {t("easyMode.guide.step2Api.desc1")}<br />
                  {t("easyMode.guide.step2Api.desc2")}<br />
                  {t("easyMode.guide.step2Api.desc3")}
                </p>
                <div className="guide-tooltip-tip">
                  {guideApiSaved ? (
                    <strong>{t("easyMode.guide.step2Api.tipSaved")}</strong>
                  ) : !apiBaseUrl.trim() || !apiKey.trim() ? (
                    t("easyMode.guide.step2Api.tipEmpty")
                  ) : !guideApiModelsFetched || apiTestedModels.length === 0 ? (
                    t("easyMode.guide.step2Api.tipFetch")
                  ) : apiSelectedModels.length === 0 ? (
                    t("easyMode.guide.step2Api.tipNoSelected")
                  ) : (
                    <span>{t("easyMode.guide.step2Api.tipSelectedCount", { count: apiSelectedModels.length })}</span>
                  )}
                </div>
              </>
            ) : null}

            {guideStep === 3 ? (
              <>
                <h4>{t("easyMode.guide.step3.heading")}</h4>
                <p>
                  {t("easyMode.guide.step3.desc1", { count: guideConnectedSourceCount })}<br />
                  {t("easyMode.guide.step3.desc2")}
                </p>
                <div className="guide-tooltip-tip">
                  {guideCanAdvance ? t("easyMode.guide.step3.tipReady") : t("easyMode.guide.step3.tipWaiting")}
                </div>
              </>
            ) : null}

            {guideStep === 4 ? (
              <>
                <h4>{t("easyMode.guide.step4.heading")}</h4>
                <p>
                  {t("easyMode.guide.step4.desc1")}<br />
                  {t("easyMode.guide.step4.desc2")}
                </p>
                <div className="guide-tooltip-tip">
                  {guideAgentConfigured ? t("easyMode.guide.step4.tipSuccess") : t("easyMode.guide.step4.tipWaiting")}
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
                  {t("easyMode.navigation.back")}
                </button>
              ) : null}

              <button
                type="button"
                className="primary-button guide-btn-sm"
                onClick={handleNextGuideStep}
                disabled={!guideCanAdvance}
              >
                {guideStep === 4 ? t("easyMode.guide.finish") : t("easyMode.navigation.next")}
              </button>
            </div>
          </div>
        </aside>
      ) : null}
    </section>
  );
}
