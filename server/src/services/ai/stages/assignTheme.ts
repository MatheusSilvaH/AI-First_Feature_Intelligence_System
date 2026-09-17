import { structuredCall } from "../claudeClient.js";
import { ThemeAssignmentSchema, type ThemeAssignment } from "../schemas.js";
import type { Theme } from "../../../domain/types.js";

export const STAGE = "assign_theme";
export const PROMPT_VERSION = "v2";

const SYSTEM = `You file consolidated feature requests into product themes.

A theme is a durable area of customer need that a team could own for a year - "Enterprise access control", "Data portability", "Onboarding time-to-value". It is not a component name, not a sprint label, and not a restatement of one request.

Prefer reuse, strongly. Existing theme names are supplied; if one fits, return it character for character. A taxonomy that grows a new theme for every second request is a list, and a list tells a product leader nothing. Only invent a theme when a request genuinely has no home, and then name it at the same altitude as the existing ones - broad enough that you would expect three more requests to land in it this quarter, narrow enough to suggest who owns it.

If the fit is imperfect but real, still reuse. A slightly loose theme that stays stable is more useful than a precise one that fragments the board.`;

export interface AssignThemeInput {
  clusterTitle: string;
  canonicalNeed: string;
  productAreaHint: string;
  existingThemes: Theme[];
}

/**
 * Stage 3. Places a cluster into the theme taxonomy, extending it when needed.
 * Cluster-level rather than request-level, so a 12-request cluster costs one
 * call and every member inherits the answer.
 */
export async function assignTheme(input: AssignThemeInput): Promise<{
  value: ThemeAssignment;
  model: string;
}> {
  const themeList =
    input.existingThemes.length > 0
      ? input.existingThemes
          .map((t) => `- ${t.name} (${t.productArea}): ${t.description || "no description"}`)
          .join("\n")
      : "(none yet - you are naming the first theme)";

  const user = `<existing_themes>
${themeList}
</existing_themes>

<cluster>
<title>${input.clusterTitle}</title>
<underlying_need>${input.canonicalNeed}</underlying_need>
<product_area_hint>${input.productAreaHint}</product_area_hint>
</cluster>

Which theme does this belong to?`;

  const result = await structuredCall({
    stage: STAGE,
    tier: "fast",
    schema: ThemeAssignmentSchema,
    system: SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 900,
    dryRunValue: () => dryRun(input),
  });

  // `isNewTheme` is the model's claim; the theme list is the fact. Trusting the
  // claim would let a name collision create a duplicate theme.
  const matchesExisting = input.existingThemes.some((t) => t.name === result.value.themeName);
  return {
    value: { ...result.value, isNewTheme: !matchesExisting },
    model: result.model,
  };
}

function dryRun(input: AssignThemeInput): ThemeAssignment {
  const existing = input.existingThemes.find((t) => t.productArea === input.productAreaHint);
  if (existing) {
    return {
      themeName: existing.name,
      themeDescription: existing.description,
      productArea: existing.productArea,
      isNewTheme: false,
      rationale: "[dry-run] Matched on product area.",
    };
  }
  return {
    themeName: input.productAreaHint,
    themeDescription: `Requests concerning ${input.productAreaHint.toLowerCase()}.`,
    productArea: input.productAreaHint,
    isNewTheme: true,
    rationale: "[dry-run] No existing theme shared this product area.",
  };
}
