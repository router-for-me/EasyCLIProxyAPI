import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, RotateCw, Users, X } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { MessageNotice } from "../appNotice";
import { useI18n } from "../i18n";
import { Select } from "../components/Select";
import {
  getZCodeSubagentConfig,
  saveZCodeSubagentConfig,
  type ZCodeSubagentConfigSnapshot,
  type ZCodeSubagentItem,
} from "../services/zcodeSubagent";
import { getAgentModels } from "../services/agents";
import type { ModelOption } from "../services/modelService";

const thoughtLevelOptions = [
  { value: "", label: "继承默认 (inherit)" },
  { value: "disabled", label: "关闭思考 (disabled)" },
  { value: "low", label: "低思考 (low)" },
  { value: "medium", label: "中思考 (medium)" },
  { value: "high", label: "高思考 (high)" },
  { value: "max", label: "最高思考 (max)" },
];

export function ZCodeSubagentConfigDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ZCodeSubagentConfigSnapshot | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultThoughtLevel, setDefaultThoughtLevel] = useState<string>("");
  const [subagents, setSubagents] = useState<ZCodeSubagentItem[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    setError("");
    void getAgentModels({ client: "zcode" }).then(setModels, () => setModels([]));
    void getZCodeSubagentConfig()
      .then((data) => {
        setSnapshot(data);
        setDefaultModel(data.defaultSubagentModel ?? "");
        setDefaultThoughtLevel(data.defaultThoughtLevel ?? "");
        setSubagents(data.subagents);
      })
      .catch((err) => setLoadError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const updateSubagentModel = (filePath: string, model: string) => {
    setSubagents((prev) =>
      prev.map((s) => (s.filePath === filePath ? { ...s, model: model || null } : s))
    );
  };

  const updateSubagentThoughtLevel = (filePath: string, thoughtLevel: string) => {
    setSubagents((prev) =>
      prev.map((s) => (s.filePath === filePath ? { ...s, thoughtLevel: thoughtLevel || null } : s))
    );
  };

  const save = async () => {
    if (loading || saving) return;
    setSaving(true);
    setError("");
    try {
      await saveZCodeSubagentConfig({
        defaultSubagentModel: defaultModel || null,
        defaultThoughtLevel: defaultThoughtLevel || null,
        subagents,
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const filteredSubagents = subagents.filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  return (
    <Dialog
      className="config-dialog zcode-subagent-dialog"
      backdropClassName="codex-catalog-backdrop"
      labelledBy="zcode-subagent-title"
      onClose={saving ? undefined : onClose}
      closeDisabled={saving}
      dismissOnBackdrop
    >
      <header
        className="config-dialog-heading"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "16px",
          paddingBottom: "12px",
          borderBottom: "1px solid var(--border-color, #e5e7eb)",
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="zcode-subagent-title" style={{ margin: 0, fontSize: "17px", display: "flex", alignItems: "center", gap: "8px", whiteSpace: "normal" }}>
            <Users size={18} style={{ flexShrink: 0 }} />
            <span>{t("agents.zcode.subagents.title") || "ZCode 子智能体设置"}</span>
          </h2>
          <p style={{ margin: "6px 0 0", fontSize: "13px", color: "var(--color-text-tertiary, #6b7280)", lineHeight: "1.4", whiteSpace: "normal" }}>
            {t("agents.zcode.subagents.description") || "配置 ZCode 子智能体（Sub-agent）的全局默认模型与思考强度，以及为各子智能体分配独立的 CPA 模型。"}
          </p>
        </div>
        <button
          type="button"
          className="icon-button quiet"
          onClick={onClose}
          disabled={saving}
          aria-label={t("common.close")}
          style={{ flexShrink: 0, marginTop: "-2px" }}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <EmptyState variant="box" role="status" className="codex-subagent-state" icon={<LoaderCircle size={18} className="spin" />}>
          {t("agents.catalog.loading")}
        </EmptyState>
      ) : loadError || !snapshot ? (
        <EmptyState
          variant="box"
          tone="error"
          role="alert"
          className="codex-subagent-state"
          icon={<CircleAlert size={18} />}
          title={t("agents.subagents.loadFailed")}
          action={
            <button type="button" className="secondary-button" onClick={load}>
              <RotateCw size={15} />
              {t("common.retry")}
            </button>
          }
        >
          {loadError || null}
        </EmptyState>
      ) : (
        <div
          className="zcode-subagent-body"
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            padding: "16px 2px 8px",
          }}
        >
          <section
            className="surface-section"
            style={{
              padding: "16px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              borderRadius: "8px",
              border: "1px solid var(--border-color, #e5e7eb)",
              background: "var(--color-surface, #ffffff)",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
              <strong>全局默认子智能体模型</strong>
              <Select value={defaultModel} onChange={(e) => setDefaultModel(e.currentTarget.value)}>
                <option value="">继承主会话默认模型</option>
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
              <strong>全局默认思考强度 (thoughtLevel)</strong>
              <Select value={defaultThoughtLevel} onChange={(e) => setDefaultThoughtLevel(e.currentTarget.value)}>
                {thoughtLevelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </label>
          </section>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div>
                <strong style={{ fontSize: "14px" }}>已检测到的子智能体 ({subagents.length})</strong>
                <p style={{ margin: "2px 0 0", fontSize: "12px", opacity: 0.7 }}>
                  可为具体子智能体（如 visual-judge）指定特定的 CPA 模型或思考强度
                </p>
              </div>
              <input
                type="text"
                placeholder="搜索智能体名称..."
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                style={{ fontSize: "12px", padding: "5px 10px", width: "180px", borderRadius: "4px", border: "1px solid var(--border-color, #d1d5db)" }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {filteredSubagents.length > 0 ? (
                filteredSubagents.map((sub) => {
                  const currentModelClean = sub.model ? sub.model.replace(/^cpa-gui\//, "") : "";
                  return (
                    <div
                      key={sub.filePath}
                      className="surface-section"
                      style={{
                        padding: "12px 16px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "14px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-color, #e5e7eb)",
                        background: "var(--color-surface, #ffffff)",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong style={{ fontSize: "13px" }}>{sub.name}</strong>
                          {sub.tools.length > 0 ? (
                            <span style={{ fontSize: "11px", opacity: 0.75, background: "var(--tag-bg, #f3f4f6)", padding: "1px 6px", borderRadius: "3px" }}>
                              [{sub.tools.slice(0, 3).join(", ")}{sub.tools.length > 3 ? "..." : ""}]
                            </span>
                          ) : null}
                        </div>
                        {sub.description ? (
                          <p style={{ margin: "4px 0 0", fontSize: "12px", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sub.description}>
                            {sub.description}
                          </p>
                        ) : null}
                      </div>

                      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                        <Select
                          value={currentModelClean}
                          onChange={(e) => {
                            const val = e.currentTarget.value ? `cpa-gui/${e.currentTarget.value}` : "";
                            updateSubagentModel(sub.filePath, val);
                          }}
                          style={{ minWidth: "160px", fontSize: "12px" }}
                        >
                          <option value="">继承默认</option>
                          {models.map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.name}
                            </option>
                          ))}
                        </Select>

                        <Select
                          value={sub.thoughtLevel ?? ""}
                          onChange={(e) => updateSubagentThoughtLevel(sub.filePath, e.currentTarget.value)}
                          style={{ minWidth: "110px", fontSize: "12px" }}
                        >
                          {thoughtLevelOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label.split(" ")[0]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ textAlign: "center", padding: "24px", opacity: 0.6, fontSize: "13px" }}>
                  未发现匹配的子智能体文件
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <MessageNotice tone="error" message={error} />

      <footer
        className="config-dialog-actions"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "10px",
          paddingTop: "14px",
          borderTop: "1px solid var(--border-color, #e5e7eb)",
          flexShrink: 0,
        }}
      >
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
