import { useMemo, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { Checkbox } from "./Checkbox";
import { Select } from "./Select";
import { Notice } from "./Notice";
import { useConfirmation } from "./ConfirmationDialog";
import { useI18n } from "../i18n";
import { usePrivacyMask } from "../privacy";
import {
  authFileIdentities,
  countAuthFileTags,
  isOAuthCredentialFile,
  normalizeAuthFileTags,
  setOAuthCredentialFileDisabled,
  type AuthFileRecord,
} from "../services/authFiles";
import {
  batchAddCredentialTag,
  batchRemoveCredentialTag,
  refreshAllCredentials,
  refreshCredential,
  runCredentialBatch,
  type CredentialResult,
} from "../services/authFileOperations";
import { managementApi, readString } from "../services/managementApi";
import { quotaKey } from "../services/quotaService";
import "./AuthFileBatchDialog.css";

export function AuthFileBatchDialog({
  files,
  onClose,
  onChanged,
}: {
  files: AuthFileRecord[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const eligible = useMemo(() => files.filter(isOAuthCredentialFile), [files]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState("");
  const [batchAddInput, setBatchAddInput] = useState("");
  const [batchRemoveTag, setBatchRemoveTag] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [results, setResults] = useState<CredentialResult[]>([]);
  const [error, setError] = useState("");
  const [feedbackNotice, setFeedbackNotice] = useState("");

  const excludedCount = files.length - eligible.length;
  const tags = useMemo(
    () => [...new Set(eligible.flatMap((file) => normalizeAuthFileTags(file.tags)))].sort((left, right) => left.localeCompare(right)),
    [eligible],
  );
  const tagCounts = useMemo(() => countAuthFileTags(eligible), [eligible]);
  const tagIdentities = useMemo(() => files.flatMap(authFileIdentities), [files]);
  const matching = useMemo(
    () => eligible.filter((file) => !tagFilter || normalizeAuthFileTags(file.tags).includes(tagFilter)),
    [eligible, tagFilter],
  );
  const targets = useMemo(
    () => matching.filter((file) => selected.has(quotaKey(file))),
    [matching, selected],
  );

  const allMatchingSelected = matching.length > 0 && matching.every((file) => selected.has(quotaKey(file)));
  const hasSomeSelected = matching.some((file) => selected.has(quotaKey(file)));
  const removableTags = useMemo(
    () => [...new Set(targets.flatMap((f) => normalizeAuthFileTags(f.tags)))].sort((a, b) => a.localeCompare(b)),
    [targets],
  );

  const selectAllMatching = () => {
    setSelected((current) => {
      const next = new Set(current);
      matching.forEach((file) => next.add(quotaKey(file)));
      return next;
    });
  };

  const clearSelection = () => {
    setSelected((current) => {
      const next = new Set(current);
      matching.forEach((file) => next.delete(quotaKey(file)));
      return next;
    });
  };

  const runBatchAddTag = async (tagOverride?: string) => {
    const tag = (tagOverride ?? batchAddInput).trim();
    if (!tag || !targets.length || busy || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setFeedbackNotice("");
    setResults([]);
    try {
      const batchRes = await batchAddCredentialTag(targets, tag);
      const succeeded = batchRes.filter((r) => r.success).length;
      const failed = batchRes.filter((r) => !r.success).length;
      if (succeeded > 0) {
        setFeedbackNotice(t("authFiles.tags.batchAddSuccess", { count: succeeded, tag }));
        setBatchAddInput("");
      }
      if (failed > 0) {
        setError(batchRes.filter((r) => !r.success).map((r) => `${r.id}: ${r.error}`).join("; "));
      }
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const runBatchRemoveTag = async () => {
    const tag = batchRemoveTag.trim();
    if (!tag || !targets.length || busy || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setFeedbackNotice("");
    setResults([]);
    try {
      const batchRes = await batchRemoveCredentialTag(targets, tag);
      const succeeded = batchRes.filter((r) => r.success).length;
      const failed = batchRes.filter((r) => !r.success).length;
      if (succeeded > 0) {
        setFeedbackNotice(t("authFiles.tags.batchRemoveSuccess", { count: succeeded, tag }));
        setBatchRemoveTag("");
      }
      if (failed > 0) {
        setError(batchRes.filter((r) => !r.success).map((r) => `${r.id}: ${r.error}`).join("; "));
      }
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const run = async (operation: "enable" | "disable" | "delete" | "refresh" | "all") => {
    if (pending.current || (operation !== "all" && !targets.length)) return;
    pending.current = true;
    setBusy(true);
    try {
      if (operation === "delete" || operation === "all") {
        const confirmed = await askConfirmation({
          title:
            operation === "delete"
              ? t(targets.length === 1 ? "authFiles.operations.deleteTitleOne" : "authFiles.operations.deleteTitle", {
                  count: targets.length,
                })
              : t("authFiles.operations.title"),
          message: t(
            operation === "delete" ? "authFiles.operations.confirmDelete" : "authFiles.operations.confirmRefresh",
            { count: targets.length },
          ),
          confirmText: t(operation === "delete" ? "common.delete" : "authFiles.operations.refreshAll"),
          ...(operation === "delete" ? { variant: "danger" as const } : {}),
        });
        if (!confirmed) return;
      }
      setError("");
      setFeedbackNotice("");
      setResults([]);
      const next =
        operation === "all"
          ? await refreshAllCredentials()
          : await runCredentialBatch(targets, async (file) => {
              if (operation === "refresh") return refreshCredential(file);
              if (operation === "delete") return managementApi.delete("/credentials", { query: { name: readString(file, "name") } });
              return setOAuthCredentialFileDisabled(file, operation === "disable");
            });
      setResults(next);
      setSelected(new Set());
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog className="model-discovery-dialog auth-batch-dialog" title={t("authFiles.operations.title")} onClose={onClose} closeDisabled={busy}>
        <div className="model-discovery-toolbar auth-batch-toolbar">
          <div className="auth-batch-selection-group">
            <Checkbox
              checked={allMatchingSelected}
              indeterminate={!allMatchingSelected && hasSomeSelected}
              disabled={busy || !matching.length}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  matching.forEach((file) => {
                    if (checked) next.add(quotaKey(file));
                    else next.delete(quotaKey(file));
                  });
                  return next;
                });
              }}
              label={`${t("authFiles.operations.selectAll")} (${targets.length}/${matching.length})`}
            />
            {tagFilter && !allMatchingSelected ? (
              <button
                type="button"
                className="secondary-button tiny-button"
                disabled={busy}
                onClick={selectAllMatching}
              >
                {t("authFiles.tags.selectAllInGroup")}
              </button>
            ) : null}
            {targets.length > 0 ? (
              <button
                type="button"
                className="secondary-button tiny-button ghost"
                disabled={busy}
                onClick={clearSelection}
              >
                {t("authFiles.operations.clearSelection")}
              </button>
            ) : null}
          </div>

          <label className="auth-batch-filter-label">
            <span>{t("authFiles.tags.selectGroup")}</span>
            <Select
              value={tagFilter}
              disabled={busy}
              onChange={(event) => {
                setTagFilter(event.currentTarget.value);
              }}
            >
              <option value="">{t("authFiles.tags.all")} ({eligible.length})</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {privacy.text(tag, tagIdentities)} ({tagCounts.get(tag) ?? 0})
                </option>
              ))}
            </Select>
          </label>

          {excludedCount > 0 ? (
            <small className="auth-batch-excluded">
              {t(excludedCount === 1 ? "authFiles.operations.excludedOne" : "authFiles.operations.excluded", { count: excludedCount })}
            </small>
          ) : null}
        </div>

        <div className="surface-section model-discovery-content auth-batch-content">
          <div className="model-discovery-list auth-batch-list">
            {matching.map((file) => {
              const fileTags = normalizeAuthFileTags(file.tags);
              const identities = authFileIdentities(file);
              return (
                <label className="model-discovery-row auth-batch-row" key={quotaKey(file)}>
                  <Checkbox
                    checked={selected.has(quotaKey(file))}
                    disabled={busy}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(quotaKey(file));
                        else next.delete(quotaKey(file));
                        return next;
                      });
                    }}
                  />
                  <span className="auth-batch-item-info">
                    <span className="auth-batch-item-name">{privacy.credentialName(file)}</span>
                    {fileTags.length ? (
                      <span className="auth-batch-tags" aria-label={t("authFiles.tags.label")}>
                        {fileTags.map((tag) => (
                          <small key={tag} className="auth-batch-tag-badge">
                            {privacy.text(tag, identities)}
                          </small>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>

          {targets.length > 0 ? (
            <div className="auth-batch-tag-ops surface-section">
              <strong className="auth-batch-tag-ops-title">
                {t("authFiles.tags.batchSectionTitle", { count: targets.length })}
              </strong>
              <div className="auth-batch-tag-controls">
                <div className="auth-batch-tag-input-group">
                  <input
                    type="text"
                    value={batchAddInput}
                    disabled={busy}
                    onChange={(e) => setBatchAddInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void runBatchAddTag();
                      }
                    }}
                    placeholder={t("authFiles.tags.batchAddPlaceholder")}
                    className="auth-batch-tag-input"
                    aria-label={t("authFiles.tags.batchAddPlaceholder")}
                  />
                  <button
                    type="button"
                    className="secondary-button small-button"
                    disabled={busy || !batchAddInput.trim()}
                    onClick={() => void runBatchAddTag()}
                  >
                    + {t("authFiles.tags.batchAdd")}
                  </button>
                </div>

                {tags.length > 0 ? (
                  <div className="auth-batch-tag-chips" aria-label={t("authFiles.tags.poolLabel")}>
                    {tags.slice(0, 10).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="filter-chip auth-batch-pool-chip"
                        disabled={busy}
                        onClick={() => void runBatchAddTag(tag)}
                        title={t("authFiles.tags.addFromPool", { tag })}
                      >
                        + {privacy.text(tag, tagIdentities)}
                      </button>
                    ))}
                  </div>
                ) : null}

                {removableTags.length > 0 ? (
                  <div className="auth-batch-tag-remove-group">
                    <Select
                      value={batchRemoveTag}
                      disabled={busy}
                      onChange={(e) => setBatchRemoveTag(e.currentTarget.value)}
                      aria-label={t("authFiles.tags.selectTagToRemove")}
                    >
                      <option value="">{t("authFiles.tags.selectTagToRemove")}</option>
                      {removableTags.map((tag) => (
                        <option key={tag} value={tag}>
                          {privacy.text(tag, tagIdentities)}
                        </option>
                      ))}
                    </Select>
                    <button
                      type="button"
                      className="danger-button small-button"
                      disabled={busy || !batchRemoveTag}
                      onClick={() => void runBatchRemoveTag()}
                    >
                      - {t("authFiles.tags.batchRemove")}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <Notice tone="error" onDismiss={() => setError("")} className="auth-batch-notice">
              {privacy.text(error, files.flatMap((file) => [readString(file, "email"), readString(file, "name")]).filter(Boolean))}
            </Notice>
          ) : null}

          {feedbackNotice ? (
            <Notice tone="success" onDismiss={() => setFeedbackNotice("")} className="auth-batch-notice">
              {feedbackNotice}
            </Notice>
          ) : null}

          {results.length > 0 ? (
            <Notice
              tone={results.some((r) => !r.success) ? "warn" : "success"}
              className="auth-batch-notice"
            >
              <p>
                {t("authFiles.operations.done", {
                  success: results.filter((result) => result.success).length,
                  failed: results.filter((result) => !result.success).length,
                })}
              </p>
              {results.map((result, index) => (
                <p key={index}>
                  {privacy.text(result.id, [result.id])} · {result.success ? "✓" : "✗"}
                  {result.error ? (
                    <small>
                      {" "}
                      ·{" "}
                      {privacy.text(
                        result.error,
                        [result.id, ...files.map((file) => readString(file, "email"))].filter(Boolean),
                      )}
                    </small>
                  ) : null}
                </p>
              ))}
            </Notice>
          ) : null}
        </div>

        <div className="model-discovery-actions">
          <button type="button" className="secondary-button small-button" disabled={busy} onClick={() => void run("all")}>
            {t("authFiles.operations.refreshAll")}
          </button>
          <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run("refresh")}>
            {t("authFiles.operations.refresh")}
          </button>
          <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run("enable")}>
            {t("common.enable")}
          </button>
          <button type="button" className="secondary-button small-button" disabled={busy || !targets.length} onClick={() => void run("disable")}>
            {t("common.disable")}
          </button>
          <button type="button" className="danger-button small-button" disabled={busy || !targets.length} onClick={() => void run("delete")}>
            {t("common.delete")}
          </button>
        </div>
      </Dialog>
      {confirmationDialog}
    </>
  );
}
