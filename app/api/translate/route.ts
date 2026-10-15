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

function getTranslationProvider(): "anthropic" | "ollama" {
  const provider = (process.env.TRANSLATION_PROVIDER ?? "anthropic").toLowerCase();
  return provider === "ollama" ? "ollama" : "anthropic";
}

async function getAnthropicResponseText(
  body: TranslateRequest,
  protectedCues: TranslationCue[],
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY тохируулаагүй байна. .env.local файлд түлхүүрээ нэмээд серверийг дахин эхлүүлнэ үү.",
    );
  }

  const anthropic = new Anthropic({ apiKey });
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

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function getOllamaResponseText(
  body: TranslateRequest,
  protectedCues: TranslationCue[],
): Promise<string> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(body.tone),
        },
        {
          role: "user",
          content: buildUserMessage(
            protectedCues,
            body.context.slice(-8),
            body.movieContext,
          ),
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Ollama request failed (${response.status}): ${detail || "Local model unavailable."}`,
    );
  }

  const payload = (await response.json()) as {
    message?: { content?: string };
  };

  const content = payload.message?.content ?? "";
  if (!content.trim()) {
    throw new Error("Ollama returned an empty response.");
  }

  return content;
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Хүсэлтийн өгөгдөл буруу байна." }, { status: 400 });
  }
  if (!isTranslateRequest(body)) {
    return NextResponse.json({ error: "Орчуулгын өгөгдөл буруу байна." }, { status: 400 });
  }

  const provider = getTranslationProvider();
  const { protectedCues, tagsById } = protectFormatting(body.cues);

  let lastError = "Энэ багцын хариу буруу форматтай байна. Дахин оролдоно уу.";

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let responseText = "";
      try {
        responseText =
          provider === "ollama"
            ? await getOllamaResponseText(body, protectedCues)
            : await getAnthropicResponseText(body, protectedCues);
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Model request failed.";
        continue;
      }

      const translations = parseTranslations(responseText, body.cues, tagsById);
      if (translations) {
        return NextResponse.json({ translations });
      }
      lastError = "Энэ багцын хариу буруу форматтай байна. Дахин оролдоно уу.";
    }

    const providerLabel = provider === "ollama" ? "Ollama" : "Anthropic";
    return NextResponse.json(
      {
        error: `${providerLabel} серверээс буруу хариу ирлээ. Дахин оролдоно уу.`,
        details: lastError,
      },
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
