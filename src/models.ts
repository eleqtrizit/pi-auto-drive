/** Minimal model shape needed for matching. */
export interface MatchableModel {
  provider: string;
  id: string;
  name?: string;
}

/** Canonical `provider/modelId` spec, the form stored in config. */
export const modelSpec = (model: MatchableModel): string => `${model.provider}/${model.id}`;

/**
 * Finds models matching a user query.
 *
 * An exact `provider/modelId` or exact model id wins outright. Otherwise every model whose spec or display name
 * contains all whitespace-separated query terms (case-insensitive) matches.
 *
 * @returns Matching models. Empty when the query is blank or nothing matches.
 */
export function matchModels<T extends MatchableModel>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exact = models.filter((m) => modelSpec(m).toLowerCase() === needle || m.id.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  const terms = needle.split(/\s+/);
  return models.filter((m) => {
    const haystack = `${modelSpec(m)} ${m.name ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
