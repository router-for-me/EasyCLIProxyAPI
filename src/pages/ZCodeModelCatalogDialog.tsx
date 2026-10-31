import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
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
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder={t("agents.catalog.search") || "搜索模型 ID"}
            />
          </div>
          <div className="codex-catalog-models" role="listbox">
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
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", cursor: "pointer" }}
                  onClick={() => setSelectedId(model.id)}
                >
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    <strong style={{ display: "block", fontSize: "13px" }}>{model.id}</strong>
                    <div style={{ display: "flex", gap: "6px", marginTop: "3px", fontSize: "11px", opacity: 0.8 }}>
                      {model.configuration.contextWindow ? (
                        <span>{Math.round(model.configuration.contextWindow / 1024)}K</span>
                      ) : null}
                      {model.configuration.supportsImage ? <span>视觉</span> : null}
                      {model.configuration.isManual ? <span style={{ color: "var(--color-primary, #d97706)" }}>已自定义</span> : null}
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={model.enabled}
                      onChange={(e) => toggleModelEnabled(model.id, e.currentTarget.checked)}
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
                      ? "手动自定义配置（已写入 manualProviderModelRules）"
                      : "智能配置（跟随网关默认推断）"}
                  </small>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <span>智能配置</span>
                  <Switch
                    checked={!selectedModel.configuration.isManual}
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({
                        ...prev,
                        isManual: !e.currentTarget.checked,
                      }))
                    }
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
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({
                        ...prev,
                        contextWindow: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                      }))
                    }
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
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({
                        ...prev,
                        maxOutputTokens: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                      }))
                    }
                  />
                </label>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <strong style={{ fontSize: "14px", display: "block", marginBottom: "8px" }}>输入模态与能力</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", fontSize: "13px" }}>
                  <Checkbox checked disabled label="文本 (必需)" onChange={() => undefined} />
                  <Checkbox
                    checked={selectedModel.configuration.supportsImage}
                    disabled={!selectedModel.configuration.isManual}
                    label="图片 / 视觉"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsImage: e.currentTarget.checked }))
                    }
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsPdf}
                    disabled={!selectedModel.configuration.isManual}
                    label="PDF 文档"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsPdf: e.currentTarget.checked }))
                    }
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsVideo}
                    disabled={!selectedModel.configuration.isManual}
                    label="视频"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsVideo: e.currentTarget.checked }))
                    }
                  />
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <strong style={{ fontSize: "14px", display: "block", marginBottom: "8px" }}>高级特性支持</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", fontSize: "13px" }}>
                  <Checkbox
                    checked={selectedModel.configuration.supportsJsonSchemaOutput}
                    disabled={!selectedModel.configuration.isManual}
                    label="结构化输出 (JSON Schema)"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsJsonSchemaOutput: e.currentTarget.checked }))
                    }
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsNativeWebSearch}
                    disabled={!selectedModel.configuration.isManual}
                    label="原生联网搜索"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsNativeWebSearch: e.currentTarget.checked }))
                    }
                  />
                  <Checkbox
                    checked={selectedModel.configuration.supportsMidConversationSystem}
                    disabled={!selectedModel.configuration.isManual}
                    label="对话中系统消息"
                    onChange={(e) =>
                      updateSelectedConfig((prev) => ({ ...prev, supportsMidConversationSystem: e.currentTarget.checked }))
                    }
                  />
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border-color, #e5e7eb)", paddingTop: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <strong style={{ fontSize: "14px" }}>思考等级 (reasoningLevel)</strong>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
                  {selectedModel.configuration.reasoningLevels.length > 0 ? (
                    selectedModel.configuration.reasoningLevels.map((lvl: string) => (
                      <span
                        key={lvl}
                        style={{
                          background: "var(--tag-bg, #f3f4f6)",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "12px",
                          border: "1px solid var(--border-color, #e5e7eb)",
                        }}
                      >
                        {lvl}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: "12px", opacity: 0.6 }}>无特定推理等级限制</span>
                  )}
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
