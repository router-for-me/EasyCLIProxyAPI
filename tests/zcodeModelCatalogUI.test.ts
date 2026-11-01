import { describe, expect, it } from "bun:test";

describe("ZCode 模型规则与智能校准逻辑", () => {
  it("思考等级 Chip 切换逻辑正确", () => {
    let levels = ["disabled", "enabled", "high"];
    const toggle = (level: string) => {
      levels = levels.includes(level)
        ? levels.filter((l) => l !== level)
        : [...levels, level];
    };

    toggle("max");
    expect(levels).toEqual(["disabled", "enabled", "high", "max"]);

    toggle("disabled");
    expect(levels).toEqual(["enabled", "high", "max"]);
  });

  it("500k 默认值被正确识别并用模型推断上限替代", () => {
    const resolveContextWindow = (optionCw: number | undefined, inferredCw: number | undefined) => {
      if (optionCw === 500000 || optionCw === undefined) {
        return inferredCw ?? optionCw;
      }
      return optionCw ?? inferredCw;
    };

    expect(resolveContextWindow(500000, 1000000)).toBe(1000000);
    expect(resolveContextWindow(2000000, 1000000)).toBe(2000000);
    expect(resolveContextWindow(undefined, 1000000)).toBe(1000000);
  });

  it("智能负向过滤：自动剔除历史调用报错失败的思考档位", () => {
    const calibrateReasoningLevels = (allLevels: string[], failedLevels: string[]) => {
      return allLevels.filter(
        (lvl) => !failedLevels.some((f) => f.toLowerCase() === lvl.toLowerCase())
      );
    };

    const initial = ["disabled", "enabled", "low", "medium", "high", "max"];
    // Assume upstream failed on 'max' due to account quota
    const calibrated = calibrateReasoningLevels(initial, ["max"]);
    expect(calibrated).toEqual(["disabled", "enabled", "low", "medium", "high"]);
    expect(calibrated.includes("max")).toBe(false);
  });
});
