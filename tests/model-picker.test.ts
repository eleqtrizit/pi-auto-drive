import { describe, expect, it } from "vitest";
import { orderScopedFirst } from "../src/model-picker.ts";
import { modelSpec } from "../src/models.ts";

const m = (provider: string, id: string) => ({ provider, id });

describe("orderScopedFirst", () => {
  const available = [m("a", "1"), m("b", "2"), m("c", "3"), m("d", "4")];

  it("puts scoped models first in scope order, then the rest in registry order", () => {
    const ordered = orderScopedFirst(available, [m("c", "3"), m("a", "1")]);
    expect(ordered.map(modelSpec)).toEqual(["c/3", "a/1", "b/2", "d/4"]);
  });

  it("drops scoped models that are not available", () => {
    expect(orderScopedFirst(available, [m("z", "9")]).map(modelSpec)).toEqual(["a/1", "b/2", "c/3", "d/4"]);
  });

  it("returns registry order when nothing is scoped", () => {
    expect(orderScopedFirst(available, [])).toEqual(available);
  });
});
