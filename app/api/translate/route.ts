import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  buildSystemPrompt,
  buildUserMessage,
  CLAUDE_MODEL,
  type TranslationTone,
} from "@/lib/prompt";

export const maxDuration = 60;

interface TranslationCue {
  id: number;
  text: string;
}

interface TranslateRequest {
  cues: TranslationCue[];
  context: string[];
  tone: TranslationTone;
  movieContext: string;
}

interface FormattingTag {
  token: string;
  original: string;
}

function isTranslateRequest(value: unknown): value is TranslateRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (
    !Array.isArray(request.cues) ||
    request.cues.length === 0 ||
    !Array.isArray(request.context) ||
    !request.context.every((entry) => typeof entry === "string") ||
    (request.tone !== "softened" && request.tone !== "faithful") ||
    typeof request.movieContext !== "string"
  ) {
    return false;
  }

  const ids = new Set<number>();
  return request.cues.every((cue: unknown) => {
    if (!cue || typeof cue !== "object") return false;
    const candidate = cue as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.id) ||
      typeof candidate.text !== "string" ||
      !candidate.text.trim() ||
      ids.has(candidate.id as number)
    ) {
      return false;
    }
    ids.add(candidate.id as number);
    return true;
  });
}

function protectFormatting(cues: TranslationCue[]) {
  const tagsById = new Map<number, FormattingTag[]>();
  let counter = 0;
  const protectedCues = cues.map(({ id, text }) => {
    const tags: FormattingTag[] = [];
    const safeText = text.replace(/<\/?[a-z][^>]*>/gi, (original) => {
      const token = `__SRT_FORMAT_${counter++}__`;
      tags.push({ token, original });
      return token;
    });
    tagsById.set(id, tags);
    return { id, text: safeText };
  });
  return { protectedCues, tagsById };
}

function parseTranslations(
  responseText: string,
  cues: TranslationCue[],
  tagsById: Map<number, FormattingTag[]>,
): TranslationCue[] | null {
  const jsonText = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const translations = (parsed as { translations?: unknown }).translations;
  if (!Array.isArray(translations) || translations.length !== cues.length) {
    return null;
  }

  const sourceIds = new Set(cues.map((cue) => cue.id));
  const translatedIds = new Set<number>();
  const result: TranslationCue[] = [];
  for (const item of translations) {
    if (
      !item ||
      typeof item !== "object" ||
      !Number.isSafeInteger((item as TranslationCue).id) ||
      typeof (item as TranslationCue).text !== "string" ||
      !(item as TranslationCue).text.trim()
    ) {
      return null;
    }
    const translation = item as TranslationCue;
    if (!sourceIds.has(translation.id) || translatedIds.has(translation.id)) {
      return null;
    }
    translatedIds.add(translation.id);

    let text = translation.text;
    for (const { token, original } of tagsById.get(translation.id) ?? []) {
      const matches = text.split(token).length - 1;
      if (matches !== 1) return null;
      text = text.replace(token, original);
    }
    result.push({ id: translation.id, text });
  }

  return translatedIds.size === sourceIds.size ? result : null;
}

export async function POST(request: Request) {
  const expectedPassword = process.env.APP_PASSWORD;
  if (!expectedPassword) {
    console.error("APP_PASSWORD is not configured.");
    return NextResponse.json(
      { error: "Серверийн тохиргоо дутуу байна." },
      { status: 500 },
    );
  }
  if (request.headers.get("x-app-password") !== expectedPassword) {
    return NextResponse.json({ error: "Нууц үг буруу байна." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Хүсэлтийн өгөгдөл буруу байна." }, { status: 400 });
  }
  if (!isTranslateRequest(body)) {
    return NextResponse.json({ error: "Орчуулгын өгөгдөл буруу байна." }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not configured.");
    return NextResponse.json(
      { error: "Орчуулгын үйлчилгээний тохиргоо дутуу байна." },
      { status: 500 },
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const { protectedCues, tagsById } = protectFormatting(body.cues);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        system: buildSystemPrompt(body.tone),
        messages: [
          {
            role: "user",
            content: buildUserMessage(
              protectedCues,
              body.context.slice(-8),
              body.movieContext,
            ),
          },
        ],
      });
      const responseText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const translations = parseTranslations(responseText, body.cues, tagsById);
      if (translations) {
        return NextResponse.json({ translations });
      }
    }
    return NextResponse.json(
      { error: "Энэ багцын хариу буруу форматтай байна. Дахин оролдоно уу." },
      { status: 502 },
    );
  } catch (error) {
    console.error("Translation request failed.", error);
    return NextResponse.json(
      { error: "Орчуулга хийхэд алдаа гарлаа. Дахин оролдоно уу." },
      { status: 502 },
    );
  }
}
