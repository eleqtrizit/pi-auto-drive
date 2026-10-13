import { describe, expect, it } from "vitest";
import { matchModels, modelSpec } from "../src/models.ts";

const models = [
  { provider: "inference", id: "azure/anthropic/claude-opus-5-5" },
  { provider: "inference", id: "aws/anthropic/bedrock-claude-opus-5-5" },
  { provider: "inference", id: "aws/anthropic/bedrock-claude-sonnet-5-5" },
  { provider: "bighank", id: "GLM-5.3-Flash", name: "GLM Flash" },
];

describe("matchModels", () => {
  it("matches a partial name anywhere in provider/id", () => {
    expect(matchModels(models, "opus").map(modelSpec)).toEqual([
      "inference/azure/anthropic/claude-opus-5-5",
      "inference/aws/anthropic/bedrock-claude-opus-5-5",
    ]);
  });
  it("requires all terms, case-insensitive", () => {
    expect(matchModels(models, "AWS opus")).toEqual([models[1]]);
  });
  it("prefers an exact spec or id over substring matches", () => {
    expect(matchModels(models, "inference/azure/anthropic/claude-opus-5-5")).toEqual([models[0]]);
    expect(matchModels(models, "glm-5.3-flash")).toEqual([models[3]]);
  });
  it("matches the display name", () => {
    expect(matchModels(models, "glm flash")).toEqual([models[3]]);
  });
  it("returns empty for blank or unknown queries", () => {
    expect(matchModels(models, "  ")).toEqual([]);
    expect(matchModels(models, "gpt")).toEqual([]);
  });
});
