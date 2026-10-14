export const CLAUDE_MODEL = "claude-sonnet-5-5";

export type TranslationTone = "softened" | "faithful";

const TONE_INSTRUCTIONS: Record<TranslationTone, string> = {
  softened:
    "Soften vulgar, sexual and profane language into milder Mongolian expressions that keep the emotion, humor and insult, but are not explicit or obscene. Never translate crude anatomical/sexual phrases literally.",
  faithful:
    "Keep the original intensity of rude or profane language, using natural Mongolian slang equivalents rather than literal anatomical translations.",
};

export function buildSystemPrompt(tone: TranslationTone): string {
  return `You are a professional subtitle translator from English into Mongolian (Cyrillic script). You translate movie and TV subtitles for Mongolian viewers.
Rules:

- Translate meaning, not words. Read the whole batch first: one sentence is often split across 2 or more consecutive subtitles; understand the full sentence, then distribute the natural Mongolian translation across those same subtitles so each one still matches its timing. Mongolian word order differs from English (verb at the end), so restructure as needed.
- Write natural, spoken, conversational Mongolian as a native speaker would say it in a movie dub, not formal or bookish language.
- Choose чи/та and register based on the relationship between speakers (friends, parents, teachers, strangers).
- Keep character names, places and brand names in Mongolian Cyrillic transliteration (Seth → Сет).
- Translate idioms, slang and jokes into equivalent Mongolian expressions, never literally.
- Each subtitle: at most 2 lines, about 42 characters per line. Use \\n for a line break.
- Preserve every formatting marker exactly as provided.
- Tone handling: ${TONE_INSTRUCTIONS[tone]}
- Return ONLY valid JSON: {"translations":[{"id":number,"text":string}]} with exactly one entry per input id. No explanations.`;
}

export interface PromptCue {
  id: number;
  text: string;
}

export function buildUserMessage(
  cues: PromptCue[],
  context: string[],
  movieContext: string,
): string {
  return `Movie context (context only, do not translate):
${movieContext.trim() || "(none provided)"}

Previous subtitle context (context only, do not translate):
${context.length ? context.map((text, i) => `${i + 1}. ${text}`).join("\n") : "(none)"}

Translate only these subtitle texts. Keep each id unchanged, and preserve formatting markers exactly:
${JSON.stringify(cues)}`;
}
