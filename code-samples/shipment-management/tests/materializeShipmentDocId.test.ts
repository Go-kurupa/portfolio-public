import { materializeShipmentDocId } from "../utils/shipmentHelpers";

describe("materializeShipmentDocId", () => {
  it("returns deterministic `${ruleId}_${dateKey}` id", () => {
    expect(
      materializeShipmentDocId("6tdaNIMMrvM8tDtsrjaW", "2026-06-19"),
    ).toBe("6tdaNIMMrvM8tDtsrjaW_2026-06-19");
  });

  it("is idempotent across calls with the same inputs", () => {
    const a = materializeShipmentDocId("qCwPkpnX9cI7aph6FJyN", "2026-06-19");
    const b = materializeShipmentDocId("qCwPkpnX9cI7aph6FJyN", "2026-06-19");
    expect(a).toBe(b);
  });

  it("differs when dateKey differs (same rule, different ship date)", () => {
    expect(
      materializeShipmentDocId("rule-x", "2026-06-19"),
    ).not.toBe(materializeShipmentDocId("rule-x", "2026-06-20"));
  });

  it("differs when ruleId differs (different rules, same date)", () => {
    expect(
      materializeShipmentDocId("rule-a", "2026-06-19"),
    ).not.toBe(materializeShipmentDocId("rule-b", "2026-06-19"));
  });

  it("throws if ruleId is empty (guards against silent fallback to random id)", () => {
    expect(() => materializeShipmentDocId("", "2026-06-19")).toThrow(
      /ruleId is required/,
    );
  });

  it("throws if dateKey is empty", () => {
    expect(() => materializeShipmentDocId("rule-x", "")).toThrow(
      /dateKey is required/,
    );
  });
});
