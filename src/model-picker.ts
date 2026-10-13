import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Text, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { matchModels, modelSpec, type MatchableModel } from "./models.ts";

const MAX_VISIBLE = 10;
const NAME_COLUMN_WIDTH = { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 70 };
export const SCOPED_LABEL = "scoped";

/**
 * Orders models with session-scoped models first (in scope order), then the rest (in registry order).
 *
 * @returns A new array without duplicates.
 */
export function orderScopedFirst<T extends MatchableModel>(available: readonly T[], scoped: readonly T[]): T[] {
  const scopedSpecs = new Set(scoped.map(modelSpec));
  const availableSpecs = new Set(available.map(modelSpec));
  const first = scoped.filter((m) => availableSpecs.has(modelSpec(m)));
  return [...first, ...available.filter((m) => !scopedSpecs.has(modelSpec(m)))];
}

/** Searchable model picker: type to filter, arrows to move, Enter to choose, Esc to cancel. */
export class ModelPicker<T extends MatchableModel> extends Container implements Focusable {
  private readonly search = new Input();
  private list!: SelectList;
  private _focused = false;

  /**
   * @param models - Models in display order.
   * @param scopedSpecs - Specs to label as scoped.
   * @param onDone - Receives the chosen model, or undefined when cancelled.
   * @param initialQuery - Prefilled search text.
   */
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    title: string,
    private readonly models: readonly T[],
    private readonly scopedSpecs: ReadonlySet<string>,
    private readonly onDone: (model: T | undefined) => void,
    initialQuery = "",
  ) {
    super();
    this.search.setValue(initialQuery);
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Text(theme.fg("dim", "Type to search · ↑↓ move · Enter select · Esc cancel"), 1, 0));
    this.addChild(this.search);
    this.rebuildList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  private visibleModels(): T[] {
    const query = this.search.getValue();
    return query.trim() ? matchModels(this.models, query) : [...this.models];
  }

  private rebuildList(): void {
    if (this.list) this.removeChild(this.list);
    const items = this.visibleModels().map((model) => ({
      value: modelSpec(model),
      label: modelSpec(model),
      description: this.scopedSpecs.has(modelSpec(model)) ? SCOPED_LABEL : undefined,
    }));
    this.list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), NAME_COLUMN_WIDTH);
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.onDone(undefined);
    } else if (kb.matches(data, "tui.select.confirm")) {
      const spec = this.list.getSelectedItem()?.value;
      const model = this.models.find((m) => modelSpec(m) === spec);
      if (model) this.onDone(model);
    } else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.list.handleInput(data);
    } else {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.rebuildList();
    }
    this.tui.requestRender();
  }
}
