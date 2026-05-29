import { describe, it, expect } from "vitest";

import { parseAutoRoute } from "../../src/sse/services/autoRouting.js";

describe("auto route parser", () => {
  it("accepts base auto route", () => {
    expect(parseAutoRoute("auto")).toEqual({ name: "auto", profile: "auto" });
  });

  it("accepts supported profiles", () => {
    expect(parseAutoRoute("auto/coding")).toEqual({ name: "auto/coding", profile: "coding" });
    expect(parseAutoRoute("auto/cheap")).toEqual({ name: "auto/cheap", profile: "cheap" });
    expect(parseAutoRoute("auto/fast")).toEqual({ name: "auto/fast", profile: "fast" });
    expect(parseAutoRoute("auto/reasoning")).toEqual({ name: "auto/reasoning", profile: "reasoning" });
  });

  it("rejects normal models", () => {
    expect(parseAutoRoute("openai/gpt-4o-mini")).toBeNull();
    expect(parseAutoRoute("auto/unknown")).toBeNull();
  });
});
