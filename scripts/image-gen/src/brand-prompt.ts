// The brand prompt prefix baked into every gpt-image-1 request.
//
// Shorted's editorial visual identity:
// - Dark backgrounds (#0a0a0a base) with orange accents (#FFA94D)
// - Data-driven, minimal, modern financial publication aesthetic
// - Australian market context where the topic warrants it
// - NEVER: stock-photo handshakes, generic cityscapes, finance clichés
//   (bull/bear icons, rocket ships, money piles, "businessman pointing
//   at chart"), AI-generated faces, text overlays.
// - Photorealistic OR isometric / geometric financial visualisation.
//
// Editorial illustration register — think The Economist + a modern data
// publication. Not a marketing banner. Not corporate stock art.

const BRAND_RULES = `
Editorial illustration in the style of a modern financial publication.
Visual style: dark background (near-black #0a0a0a) with selective orange
accents (#FFA94D) used sparingly for emphasis. Minimal, clean,
composition-driven. Subtle grain or noise acceptable. High contrast.

NEVER include:
- Text, words, numbers, or letters of any kind in the image
- Stock-photo clichés: handshakes, generic city skylines, businessmen
  pointing at charts, money stacks, gold bars, suited figures
- Finance icon clichés: bulls, bears, rocket ships, dollar signs,
  thumbs up/down, arrows in/out of cartoonish bags
- Photorealistic human faces (faces blur, abstract, or omit entirely)
- Cartoon or 3D-render-asset-pack style; nothing that reads as clip art

Preferred treatments:
- Photorealistic close-up of a relevant industrial/material subject
- Isometric or geometric data-visualisation aesthetic (abstract bars,
  flows, gradients)
- Architectural/material textures referencing the topic (ore, metal,
  glass, paper, document close-ups)
- Single subject, off-centre composition with negative space
- Australian setting cues only when the topic is geographically specific

Topic to illustrate:`;

export interface PromptInput {
  topic: string;
  type: "hero" | "thumbnail" | "inline";
  additionalContext?: string;
}

/**
 * Build the full gpt-image-1 prompt for an asset.
 * Topic is the editorial subject; the brand rules are the constant prefix.
 */
export function buildImagePrompt(input: PromptInput): string {
  const sizeHint =
    input.type === "hero"
      ? "16:9 horizontal hero banner composition"
      : input.type === "thumbnail"
        ? "square thumbnail composition, single strong subject"
        : "horizontal editorial illustration, supports inline article placement";

  const lines = [
    BRAND_RULES,
    "",
    input.topic.trim(),
    "",
    `Format: ${sizeHint}.`,
  ];
  if (input.additionalContext) {
    lines.push("", `Additional context: ${input.additionalContext.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Recommended gpt-image-1 size for each asset type. Standard quality.
 * gpt-image-1 supports: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape).
 */
export function imageSizeFor(type: PromptInput["type"]): "1024x1024" | "1536x1024" {
  switch (type) {
    case "hero":
    case "inline":
      return "1536x1024";
    case "thumbnail":
      return "1024x1024";
  }
}
