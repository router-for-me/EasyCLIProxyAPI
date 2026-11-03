import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { ZCodeCatalogEditorModel, ZCodeModelConfig } from "../src/services/zcodeModelCatalog";

const dialogSource = readFileSync(new URL("../src/pages/ZCodeModelCatalogDialog.tsx", import.meta.url), "utf8");
const configurationSource = readFileSync(new URL("../src-tauri/src/agents/configuration.rs", import.meta.url), "utf8");
const catalogSource = readFileSync(new URL("../src-tauri/src/agents/zcode.rs", import.meta.url), "utf8");
const usageSource = readFileSync(new URL("../src-tauri/src/usage.rs", import.meta.url), "utf8");

function createEditor() {
  const defaults: ZCodeModelConfig = {
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsImage: true,
    supportsPdf: false,
    supportsVideo: false,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: true,
    supportsMidConversationSystem: true,
    reasoningLevels: ["high"],
    isManual: false,
  };
  let models: ZCodeCatalogEditorModel[] = ["selected", "other"].map((id) => ({
    id,
    enabled: true,
    configuration: { ...defaults },
    defaults,
  }));
  const callbacks = dialogSource.slice(
    dialogSource.indexOf("  const updateSelectedConfig ="),
    dialogSource.indexOf("  const restoreSelectedDefaults =")
  );
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const createCallbacks = new Function("setModels", "selectedId", "selectedModel", transpiler.transformSync(`
    ${callbacks}
    return { updateSelectedConfig, toggleReasoningLevel };
  `));
  const editor = createCallbacks(
    (updater: (previous: ZCodeCatalogEditorModel[]) => ZCodeCatalogEditorModel[]) => {
      models = updater(models);
    },
    "selected",
    models[0]
  ) as {
    updateSelectedConfig: (updater: (previous: ZCodeModelConfig) => ZCodeModelConfig) => void;
    toggleReasoningLevel: (level: string) => void;
  };
  const activeLevels = dialogSource.match(/const activeLevels = ([\s\S]*?);/)?.[1];
  expect(activeLevels).toBeDefined();
  const getActiveLevels = new Function("selectedModel", `return ${activeLevels};`);
  return {
    ...editor,
    models: () => models,
    activeLevels: (): string[] => getActiveLevels(models[0]),
  };
}

describe("ZCode model catalog editing", () => {
  it.each([
    ["contextWindow", 123_456],
    ["maxOutputTokens", 12_345],
    ["reasoningLevels", []],
    ["supportsImage", false],
    ["supportsPdf", true],
    ["supportsVideo", true],
    ["supportsJsonSchemaOutput", false],
    ["supportsNativeWebSearch", false],
    ["supportsMidConversationSystem", false],
    ["reasoningMap", "{}"],
  ] as const)("marks edits to %s as manual", (field, value) => {
    const editor = createEditor();
    const other = editor.models()[1];
    editor.updateSelectedConfig((previous) => ({ ...previous, [field]: value }));
    expect(editor.models()[0].configuration[field]).toEqual(value);
    expect(editor.models()[0].configuration.isManual).toBe(true);
    expect(editor.models()[1]).toBe(other);
    expect(editor.models()[0].defaults.isManual).toBe(false);
  });

  it("keeps the final chip deselected and toggles from an empty selection", () => {
    const editor = createEditor();
    editor.toggleReasoningLevel("high");
    expect(editor.models()[0].configuration.reasoningLevels).toEqual([]);
    expect(editor.activeLevels()).toEqual([]);
    expect(editor.models()[0].configuration.isManual).toBe(true);
    editor.toggleReasoningLevel("low");
    expect(editor.activeLevels()).toEqual(["low"]);
    editor.toggleReasoningLevel("low");
    editor.toggleReasoningLevel("high");
    expect(editor.activeLevels()).toEqual(["high"]);
  });

  it("serializes and parses an explicit empty reasoning array without restoring defaults", () => {
    const parser = catalogSource.slice(
      catalogSource.indexOf("fn parse_zcode_rule_reasoning("),
      catalogSource.indexOf("fn build_zcode_rule_object(")
    );
    expect(parser).toContain(".and_then(Value::as_array)");
    expect(parser).not.toContain(".filter(|v| !v.is_empty())");
    const builder = catalogSource.slice(
      catalogSource.indexOf("fn build_zcode_rule_object("),
      catalogSource.indexOf("pub(crate) fn zcode_editor_snapshot(")
    );
    expect(builder).toContain('rl.insert("values".into(), serde_json::json!(config.reasoning_levels))');
    expect(builder).not.toContain("if !config.reasoning_levels.is_empty()");
    expect(builder).not.toContain('option_specs.insert("reasoningLevel".into(), Value::Null)');
  });

  it("preserves explicit manual context windows before inference on apply and reload", () => {
    const apply = configurationSource.slice(configurationSource.indexOf("let effective_cw = match option.context_window"));
    expect(apply).toMatch(/Some\(500_000\) \| None => manual\s*\.and_then\(\|rule\| rule.pointer\("\/config\/properties\/contextWindow"\)\)\s*\.and_then\(serde_json::Value::as_u64\)\s*\.or\(inferred_cw\)\s*\.or\(option.context_window\)/);
    const manualSnapshot = catalogSource.slice(
      catalogSource.indexOf("let configuration = if let Some(manual_rule)"),
      catalogSource.indexOf("} else if let Some(prov_rule)")
    );
    expect(manualSnapshot).toContain("let effective_cw = cw.or(default_config.context_window);");
  });

  it("requires reasoning-specific rejection evidence for calibration", () => {
    const predicate = usageSource.slice(
      usageSource.indexOf("let is_effort_failure ="),
      usageSource.indexOf("if is_effort_failure {")
    );
    expect(predicate).toContain("failure_status == Some(400) || failure_status == Some(422)");
    expect(predicate).toContain("mentions_reasoning && rejects_parameter");
    const mentionsReasoning = predicate.match(/let mentions_reasoning = ([\s\S]*?);/)?.[1];
    const rejectsParameter = predicate.match(/let rejects_parameter = ([\s\S]*?);/)?.[1];
    expect(mentionsReasoning).toBeDefined();
    expect(rejectsParameter).toBeDefined();
    const evaluate = (expression: string, body: string) => new Function(
      "lower", `return ${expression.replaceAll(".contains(", ".includes(")};`
    )(body.toLowerCase()) as boolean;
    const isRejection = (body: string) => evaluate(mentionsReasoning!, body) && evaluate(rejectsParameter!, body);
    for (const body of ["unsupported image format", "invalid API key", "reasoning request exceeded quota", "thinking timed out"]) {
      expect(isRejection(body)).toBe(false);
    }
    for (const body of ["unsupported reasoning", "unsupported effort", "thinking not supported", "invalid thought parameter", "Invalid reasoning_effort: xhigh"]) {
      expect(isRejection(body)).toBe(true);
    }
  });
});
