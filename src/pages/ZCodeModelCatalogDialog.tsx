import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Plus, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { Checkbox } from "../components/Checkbox";
import { MessageNotice } from "../appNotice";
import { useI18n } from "../i18n";
import {
  getZCodeModelCatalogEditor,
  saveZCodeModelCatalogEditor,
  type ZCodeCatalogEditorModel,
  type ZCodeCatalogEditorSnapshot,
} from "../services/zcodeModelCatalog";

const COMMON_REASONING_LEVELS = ["disabled", "enabled", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ZCodeModelCatalogDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ZCodeCatalogEditorSnapshot | null>(null);
  const [models, setModels] = useState<ZCodeCatalogEditorModel[]>([]);
  const [modelOrder, setModelOrder] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [customLevelInput, setCustomLevelInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await getZCodeModelCatalogEditor();
      setSnapshot(next);
      setModels(next.models);
      setModelOrder(next.modelOrder);
      if (next.models.length > 0 && !selectedId) {
        setSelectedId(next.models[0].id);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selectedId) ?? null,
    [models, selectedId]
  );

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, search]);

  const toggleModelEnabled = (id: string, enabled: boolean) => {
    setModels((prev) =>
      prev.map((m) => (m.id === id ? { ...m, enabled } : m))
    );
  };

  const updateSelectedConfig = (
    updater: (prev: ZCodeCatalogEditorModel["configuration"]) => ZCodeCatalogEditorModel["configuration"]
  ) => {
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) => (m.id === selectedId ? { ...m, configuration: updater(m.configuration) } : m))
    );
  };

  const toggleSmartConfig = (enabled: boolean) => {
    if (!selectedModel) return;
    if (enabled) {
      // Switch to smart config (isManual = false), restore defaults
      setModels((prev) =>
        prev.map((m) =>
          m.id === selectedId
            ? { ...m, configuration: { ...m.defaults, isManual: false } }
            : m
        )
      );
    } else {
      // Switch to manual config (isManual = true), ensure full config fields are present
      setModels((prev) =>
        prev.map((m) => {
          if (m.id !== selectedId) return m;
          const current = m.configuration;
          return {
            ...m,
            configuration: {
              ...current,
              isManual: true,
              contextWindow: current.contextWindow ?? m.defaults.contextWindow ?? 1048576,
              maxOutputTokens: current.maxOutputTokens ?? m.defaults.maxOutputTokens ?? 128000,
              supportsImage: current.supportsImage ?? true,
              supportsPdf: current.supportsPdf ?? false,
              supportsVideo: current.supportsVideo ?? false,
              supportsJsonSchemaOutput: current.supportsJsonSchemaOutput ?? true,
              supportsNativeWebSearch: current.supportsNativeWebSearch ?? true,
              supportsMidConversationSystem: current.supportsMidConversationSystem ?? true,
              reasoningLevels: current.reasoningLevels.length
                ? [...current.reasoningLevels]
                : m.defaults.reasoningLevels.length
                ? [...m.defaults.reasoningLevels]
                : ["disabled", "enabled", "high"],
              reasoningMap: current.reasoningMap ?? m.defaults.reasoningMap,
            },
          };
        })
      );
    }
  };

  const toggleReasoningLevel = (level: string) => {
    if (!selectedModel || !selectedModel.configuration.isManual) return;
    updateSelectedConfig((prev) => {
      const exists = prev.reasoningLevels.includes(level);
      const nextLevels = exists
        ? prev.reasoningLevels.filter((l) => l !== level)
        : [...prev.reasoningLevels, level];
      return { ...prev, reasoningLevels: nextLevels };
    });
  };

  const addCustomReasoningLevel = () => {
    const val = customLevelInput.trim();
    if (!val || !selectedModel || !selectedModel.configuration.isManual) return;
    updateSelectedConfig((prev) => {
      if (prev.reasoningLevels.includes(val)) return prev;
      return { ...prev, reasoningLevels: [...prev.reasoningLevels, val] };
    });
    setCustomLevelInput("");
  };

  const removeReasoningLevel = (level: string) => {
    if (!selectedModel || !selectedModel.configuration.isManual) return;
    updateSelectedConfig((prev) => ({
      ...prev,
      reasoningLevels: prev.reasoningLevels.filter((l) => l !== level),
    }));
  };

  const restoreSelectedDefaults = () => {
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) => (m.id === selectedId ? { ...m, configuration: { ...m.defaults } } : m))
    );
  };

  const save = async () => {
    if (loading || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await saveZCodeModelCatalogEditor({
        models,
        modelOrder,
      });
      setSnapshot(next);
      setModels(next.models);
      setModelOrder(next.modelOrder);
      setNotice(t("agents.zcode.catalog.saved") || "ZCode 模型设置已保存并同步至 provider_config.json");
      await onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      className="config-dialog codex-catalog-dialog"
      backdropClassName="codex-catalog-backdrop"
      labelledBy="zcode-catalog-title"
      onClose={saving ? undefined : onClose}
      closeDisabled={saving}
      dismissOnBackdrop
    >
      <header className="config-dialog-heading codex-catalog-heading">
        <div>
          <h2 id="zcode-catalog-title">
            <SlidersHorizontal size={18} style={{ display: "inline", verticalAlign: "middle", marginRight: 8 }} />
            {t("agents.zcode.catalog.title") || "ZCode 模型列表与规则设置"}
          </h2>
          <p>{t("agents.zcode.catalog.subtitle") || "管理注入到 ZCode 的可见模型列表、排序以及上下文窗口和推理配置。"}</p>
        </div>
        <button type="button" className="icon-button quiet" onClick={onClose} disabled={saving} aria-label={t("common.close")}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="surface-section codex-catalog-body">
        <aside className="codex-catalog-sidebar">
          <div className="codex-catalog-search search-control" data-size="default">
            <Search size={15} aria-hidden />
            <input
              value={search}
              onChange={(e) => {
                const val = e.currentTarget.value;
                setSearch(val);
              }}
              placeholder={t("agents.catalog.search") || "搜索模型 ID"}
            />
          </div>
          <div className="codex-catalog-models" role="listbox" style={{ overflowX: "hidden", overflowY: "auto", scrollbarWidth: "thin" }}>
            {loading ? (
              <div className="codex-catalog-state">
                <LoaderCircle size={18} className="spin" />
                {t("agents.catalog.loading")}
              </div>
            ) : filteredModels.length ? (
              filteredModels.map((model) => (
                <div
                  key={model.id}
                  className={`codex-catalog-item ${model.id === selectedId ? "active" : ""}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    cursor: "pointer",
                    minWidth: 0,
                    width: "100%",
                    boxSizing: "border-box",
                    borderRadius: "6px",
                    background: model.id === selectedId ? "var(--ui-accent-soft, rgba(0,0,0,0.06))" : undefined,
                  }}
                  onClick={() => setSelectedId(model.id)}
                >
                  <div style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: "8px" }}>
                    <strong style={{ display: "block", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {model.id}
                    </strong>
                    <div style={{ display: "flex", gap: "6px", marginTop: "3px", fontSize: "11px", opacity: 0.8 }}>
                      {model.configuration.contextWindow ? (
                        <span>{Math.round(model.configuration.contextWindow / 1024)}K</span>
                      ) : null}
                      {model.configuration.supportsImage ? <span>视觉</span> : null}
                      {model.configuration.isManual ? <span style={{ color: "var(--color-primary, #d97706)" }}>已自定义</span> : null}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <Switch
                      size="sm"
                      checked={model.enabled}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        toggleModelEnabled(model.id, checked);
                      }}
                      title={model.enabled ? "在 ZCode 中启用" : "在 ZCode 中隐藏"}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="codex-catalog-state">{t("agents.catalog.empty")}</div>
            )}
          </div>
        </aside>

        <main className="codex-catalog-editor" style={{ padding: "16px 20px", overflowY: "auto" }}>
          {selectedModel ? (
            <div className="zcode-model-form" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color, #e5e7eb)", paddingBottom: "12px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px" }}>{selectedModel.id}</h3>
                  <small style={{ opacity: 0.7 }}>
                    {selectedModel.configuration.isManual
                      ? "手动自定义配置（关闭智能配置，写入 manualProviderModelRules）"
                      : "智能配置开启（继承网关默认推断，写入 providerModelRules）"}
                  </small>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <span>智能配置</span>
                  <Switch
                    checked={!selectedModel.configuration.isManual}
                    onChange={(e) => {
                      const smart = e.currentTarget.checked;
                      toggleSmartConfig(smart);
                    }}
                  />
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
                  <strong>上下文窗口 (Tokens)</strong>
                  <input
                    type="number"
                    min={1}
                    step={1024}
                    value={selectedModel.configuration.contextWindow ?? ""}
                    placeholder="例如 1048576"
                    disabled={!selectedModel.configuration.isManual}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      updateSelectedConfig((prev) => ({
                        ...prev,
                        contextWindow: val ? Number(val) : undefined,
                      }));
                    }}
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
                  <strong>最大输出 Token</strong>
                  <input
                    type="number"
                    min={1}
                    step={1024}
                    value={selectedModel.configuration.maxOutputTokens ?? ""}
                    placeholder="留空使用默认 (例如 128000)"
                    disabled={!selectedModel.configuration.isManual}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      updateSelectedConfig((prev) => ({
                        ...prev,
                        maxOutputTokens: val ? Number(val) : undefined,
                      }));
                    }}
                  />
                </label>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <strong style={{ fontSize: "14px", display: "block", marginBottom: "8px" }}>输入模态与类型</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", fontSize: "13px" }}>
                  <Checkbox checked disabled label="文本 (必需)" onChange={() => undefined} />
                  <Checkbox
                    checked={selectedModel.configuration.supportsImage}
                    disabled={!selectedModel.configuration.isManual}
                    label="图片 / 视觉"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsImage: chk }));
                    }}
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsPdf}
                    disabled={!selectedModel.configuration.isManual}
                    label="PDF 文档"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsPdf: chk }));
                    }}
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsVideo}
                    disabled={!selectedModel.configuration.isManual}
                    label="视频"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsVideo: chk }));
                    }}
                  />
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <strong style={{ fontSize: "14px", display: "block", marginBottom: "8px" }}>高级模型能力</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", fontSize: "13px" }}>
                  <Checkbox
                    checked={selectedModel.configuration.supportsJsonSchemaOutput}
                    disabled={!selectedModel.configuration.isManual}
                    label="结构化输出 (JSON Schema)"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsJsonSchemaOutput: chk }));
                    }}
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsNativeWebSearch}
                    disabled={!selectedModel.configuration.isManual}
                    label="原生联网搜索"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsNativeWebSearch: chk }));
                    }}
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsMidConversationSystem}
                    disabled={!selectedModel.configuration.isManual}
                    label="对话中系统消息"
                    onChange={(e) => {
                      const chk = e.currentTarget.checked;
                      updateSelectedConfig((prev) => ({ ...prev, supportsMidConversationSystem: chk }));
                    }}
                  />
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <strong style={{ fontSize: "14px" }}>思考等级 (reasoningLevel)</strong>
                </div>

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                  {selectedModel.configuration.reasoningLevels.length > 0 ? (
                    selectedModel.configuration.reasoningLevels.map((lvl: string) => (
                      <span
                        key={lvl}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          background: "var(--tag-bg, #f3f4f6)",
                          padding: "3px 8px",
                          borderRadius: "4px",
                          fontSize: "12px",
                          border: "1px solid var(--border-color, #e5e7eb)",
                        }}
                      >
                        <strong>{lvl}</strong>
                        {selectedModel.configuration.isManual ? (
                          <button
                            type="button"
                            onClick={() => removeReasoningLevel(lvl)}
                            style={{
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              padding: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              color: "var(--color-text-tertiary, #9ca3af)",
                            }}
                            title={`移除 ${lvl}`}
                          >
                            <X size={12} />
                          </button>
                        ) : null}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: "12px", opacity: 0.6 }}>无特定推理等级限制</span>
                  )}
                </div>

                {selectedModel.configuration.isManual ? (
                  <div style={{ background: "var(--color-surface-hover, #fafafa)", padding: "10px 12px", borderRadius: "6px", border: "1px dashed var(--border-color, #d1d5db)" }}>
                    <span style={{ fontSize: "12px", fontWeight: "bold", display: "block", marginBottom: "6px" }}>
                      快捷增删常见思考等级:
                    </span>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
                      {COMMON_REASONING_LEVELS.map((lvl) => {
                        const active = selectedModel.configuration.reasoningLevels.includes(lvl);
                        return (
                          <button
                            type="button"
                            key={lvl}
                            onClick={() => toggleReasoningLevel(lvl)}
                            className="secondary-button"
                            style={{
                              fontSize: "11px",
                              padding: "2px 8px",
                              height: "26px",
                              background: active ? "var(--color-primary-subtle, #fef3c7)" : undefined,
                              borderColor: active ? "var(--color-primary, #d97706)" : undefined,
                              color: active ? "var(--color-primary, #d97706)" : undefined,
                              fontWeight: active ? "bold" : "normal",
                            }}
                          >
                            {active ? "✓ " : "+ "}
                            {lvl}
                          </button>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        type="text"
                        value={customLevelInput}
                        onChange={(e) => setCustomLevelInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addCustomReasoningLevel();
                          }
                        }}
                        placeholder="输入自定义等级名称..."
                        style={{ fontSize: "12px", padding: "4px 8px", width: "180px" }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={addCustomReasoningLevel}
                        style={{ fontSize: "12px", height: "28px", padding: "0 10px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        <Plus size={13} />
                        添加
                      </button>
                    </div>
                  </div>
                ) : null}

                <div style={{ marginTop: "12px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                    <span style={{ opacity: 0.8 }}>推理参数映射 (map 表达式)</span>
                    <textarea
                      rows={2}
                      value={selectedModel.configuration.reasoningMap ?? ""}
                      placeholder={'reasoningLevel == "none" ? {"thinking": {"type": "disabled"}} : {"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}'}
                      disabled={!selectedModel.configuration.isManual}
                      onChange={(e) => {
                        const val = e.currentTarget.value;
                        updateSelectedConfig((prev) => ({ ...prev, reasoningMap: val || undefined }));
                      }}
                      style={{ fontFamily: "monospace", fontSize: "11px", padding: "6px", resize: "vertical" }}
                    />
                  </label>
                </div>
              </div>

              <div style={{ marginTop: "12px" }}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={restoreSelectedDefaults}
                  disabled={!selectedModel.configuration.isManual || saving}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}
                >
                  <RotateCcw size={14} />
                  恢复此模型默认推断
                </button>
              </div>
            </div>
          ) : (
            <div className="codex-catalog-state">{t("agents.catalog.empty")}</div>
          )}
        </main>
      </div>

      <MessageNotice tone="error" message={error} />
      <MessageNotice tone="info" message={notice} />

      <footer className="config-dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: "10px", padding: "14px 20px" }}>
        <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary-button" onClick={() => void save()} disabled={loading || saving}>
          {saving ? <LoaderCircle size={16} className="spin" /> : null}
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </footer>
    </Dialog>
  );
}
