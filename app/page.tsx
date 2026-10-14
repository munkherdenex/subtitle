"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { parseSrt, serializeSrt, type SubtitleCue } from "@/lib/srt";
import type { TranslationTone } from "@/lib/prompt";

const BATCH_SIZE = 60;
const PASSWORD_STORAGE_KEY = "subtitle-translator-password";

interface TranslationBatch {
  number: number;
  start: number;
  cues: SubtitleCue[];
  status: "pending" | "translating" | "done" | "error";
  error?: string;
}

interface TranslationResponse {
  translations: Array<{ id: number; text: string }>;
}

function getBatchCues(cues: SubtitleCue[], start: number): SubtitleCue[] {
  return cues.slice(start, start + BATCH_SIZE);
}

export default function Home() {
  const [fileName, setFileName] = useState("");
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [batches, setBatches] = useState<TranslationBatch[]>([]);
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [password, setPassword] = useState("");
  const [tone, setTone] = useState<TranslationTone>("softened");
  const [movieContext, setMovieContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    try {
      setPassword(localStorage.getItem(PASSWORD_STORAGE_KEY) ?? "");
    } catch {
      setMessage("Хөтчийн санах ойд нэвтрэх боломжгүй байна. Нууц үгээ дахин оруулна уу.");
    }
  }, []);

  const completedCount = useMemo(
    () => batches.filter((batch) => batch.status === "done").length,
    [batches],
  );
  const hasTranslations = Object.keys(translations).length > 0;
  const allDone = batches.length > 0 && completedCount === batches.length;

  async function readFile(file: File) {
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".srt") && !lowerName.endsWith(".docx")) {
      setMessage("Зөвхөн .srt эсвэл .docx файл сонгоно уу.");
      return;
    }

    try {
      let contents: string;
      if (lowerName.endsWith(".docx")) {
        const mammoth = await import("mammoth");
        const extracted = await mammoth.extractRawText({
          arrayBuffer: await file.arrayBuffer(),
        });
        contents = extracted.value;
      } else {
        contents = new TextDecoder("utf-8").decode(await file.arrayBuffer());
      }
      const parsed = parseSrt(contents);
      setFileName(file.name);
      setCues(parsed);
      setBatches([]);
      setTranslations({});
      setMessage(`${parsed.length} хадмал мөр уншлаа.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Файлыг уншихад алдаа гарлаа.",
      );
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  async function translateBatch(batch: TranslationBatch): Promise<void> {
    const inputCues = batch.cues.map((cue, offset) => ({
      id: batch.start + offset,
      text: cue.text,
    }));
    const context = cues
      .slice(Math.max(0, batch.start - 8), batch.start)
      .map((cue) => cue.text);
    let lastError = "Багцыг орчуулахад алдаа гарлаа.";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-app-password": password,
          },
          body: JSON.stringify({
            cues: inputCues,
            context,
            tone,
            movieContext,
          }),
        });
        const result = (await response.json()) as
          | TranslationResponse
          | { error?: string };
        if (!response.ok) {
          throw new Error("error" in result ? result.error : undefined);
        }
        if (!("translations" in result) || result.translations.length !== inputCues.length) {
          throw new Error("Орчуулгын хариу бүрэн бус байна.");
        }
        const expectedIds = new Set(inputCues.map(({ id }) => id));
        const nextTranslations: Record<number, string> = {};
        for (const item of result.translations) {
          if (
            !expectedIds.has(item.id) ||
            typeof item.text !== "string" ||
            !item.text.trim() ||
            nextTranslations[item.id] !== undefined
          ) {
            throw new Error("Орчуулгын хариу буруу форматтай байна.");
          }
          nextTranslations[item.id] = item.text;
        }
        if (Object.keys(nextTranslations).length !== inputCues.length) {
          throw new Error("Орчуулгын мөр дутуу байна.");
        }
        setTranslations((previous) => ({ ...previous, ...nextTranslations }));
        try {
          localStorage.setItem(PASSWORD_STORAGE_KEY, password);
        } catch {
          setMessage("Орчуулга амжилттай. Нууц үгийг хөтөчид хадгалж чадсангүй.");
        }
        setBatches((previous) =>
          previous.map((item) =>
            item.number === batch.number
              ? { ...item, status: "done", error: undefined }
              : item,
          ),
        );
        return;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Сүлжээний алдаа гарлаа.";
      }
    }

    setBatches((previous) =>
      previous.map((item) =>
        item.number === batch.number
          ? { ...item, status: "error", error: lastError }
          : item,
      ),
    );
  }

  async function translateAll() {
    if (!cues.length || !password.trim()) {
      setMessage(!cues.length ? "Эхлээд хадмал файл сонгоно уу." : "Нууц үгээ оруулна уу.");
      return;
    }
    const nextBatches: TranslationBatch[] = [];
    for (let start = 0; start < cues.length; start += BATCH_SIZE) {
      nextBatches.push({
        number: nextBatches.length + 1,
        start,
        cues: getBatchCues(cues, start),
        status: "pending",
      });
    }
    setBusy(true);
    setMessage("");
    setTranslations({});
    setBatches(nextBatches);
    for (const batch of nextBatches) {
      setBatches((previous) =>
        previous.map((item) =>
          item.number === batch.number ? { ...item, status: "translating" } : item,
        ),
      );
      await translateBatch(batch);
    }
    setBusy(false);
  }

  async function retryBatch(number: number) {
    const batch = batches.find((item) => item.number === number);
    if (!batch || busy) return;
    setBusy(true);
    setBatches((previous) =>
      previous.map((item) =>
        item.number === number ? { ...item, status: "translating", error: undefined } : item,
      ),
    );
    await translateBatch(batch);
    setBusy(false);
  }

  function downloadSrt() {
    const translatedCues = cues.map((cue, index) => ({
      ...cue,
      text: translations[index] ?? cue.text,
    }));
    const blob = new Blob([serializeSrt(translatedCues)], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName.replace(/\.[^.]+$/, "")}.mn.srt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const currentBatch = batches.find((batch) => batch.status === "translating");

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 sm:mb-10">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Subtitle studio
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Кино хадмал орчуулагч
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-stone-600">
            Англи хадмалаа оруулаад, утга санааг нь алдагдуулахгүйгээр монгол хэл рүү хөрвүүлээрэй.
          </p>
        </header>

        <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-8">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`rounded-2xl border-2 border-dashed px-5 py-8 text-center transition sm:px-8 ${
              dragging
                ? "border-emerald-600 bg-emerald-50"
                : "border-stone-300 bg-stone-50"
            }`}
          >
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-800">
              ↑
            </div>
            <p className="font-semibold">Хадмал файлаа энд чирж оруулна уу</p>
            <p className="mt-1 text-sm text-stone-500">.srt эсвэл SRT тексттэй .docx</p>
            <label className="mt-5 inline-flex cursor-pointer items-center rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-stone-700">
              Файл сонгох
              <input
                className="sr-only"
                type="file"
                accept=".srt,.docx"
                onChange={handleFileChange}
              />
            </label>
            {fileName && (
              <p className="mt-4 text-sm font-medium text-emerald-800">
                {fileName} · {cues.length} мөр
              </p>
            )}
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              Нууц үг
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Аппын нууц үг"
                className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-3 font-normal outline-none transition placeholder:text-stone-400 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
              />
            </label>
            <label className="block text-sm font-semibold">
              Орчуулгын өнгө
              <select
                value={tone}
                onChange={(event) => setTone(event.target.value as TranslationTone)}
                className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-3 font-normal outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
              >
                <option value="softened">Зөөлрүүлсэн — бүдүүлэг үгийг аядуулах</option>
                <option value="faithful">Үнэнч — эхийн хүч, өнгийг хадгалах</option>
              </select>
            </label>
            <label className="block text-sm font-semibold sm:col-span-2">
              Киноны тухай нэмэлт мэдээлэл <span className="font-normal text-stone-500">(заавал биш)</span>
              <textarea
                value={movieContext}
                onChange={(event) => setMovieContext(event.target.value)}
                rows={3}
                placeholder="Жишээ: Superbad, 2007 оны өсвөр насныхны инээдмийн кино..."
                className="mt-2 w-full resize-y rounded-xl border border-stone-300 bg-white px-3.5 py-3 font-normal outline-none transition placeholder:text-stone-400 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
              />
            </label>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              disabled={!cues.length || busy}
              onClick={() => void translateAll()}
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-emerald-700 px-6 py-3 font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {busy ? "Орчуулж байна…" : "Орчуулах"}
            </button>
            {hasTranslations && (
              <button
                type="button"
                disabled={!allDone}
                onClick={downloadSrt}
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-stone-300 px-6 py-3 font-semibold transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                .srt татах
              </button>
            )}
            {message && <p role="status" className="text-sm text-stone-600">{message}</p>}
          </div>

          {batches.length > 0 && (
            <div className="mt-6" aria-live="polite">
              <div className="mb-2 flex justify-between text-sm text-stone-600">
                <span>
                  {busy && currentBatch
                    ? `Багц ${currentBatch.number} / ${batches.length}`
                    : `Дууссан багц ${completedCount} / ${batches.length}`}
                </span>
                <span>{Math.round((completedCount / batches.length) * 100)}%</span>
              </div>
              <div
                className="h-2.5 overflow-hidden rounded-full bg-stone-200"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={batches.length}
                aria-valuenow={completedCount}
                aria-label="Орчуулгын явц"
              >
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all"
                  style={{ width: `${(completedCount / batches.length) * 100}%` }}
                />
              </div>
              {batches.some((batch) => batch.status === "error") && (
                <div className="mt-3 space-y-2">
                  {batches
                    .filter((batch) => batch.status === "error")
                    .map((batch) => (
                      <div
                        key={batch.number}
                        className="flex flex-col gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span>Багц {batch.number}: {batch.error}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void retryBatch(batch.number)}
                          className="self-start font-semibold underline disabled:opacity-50 sm:self-auto"
                        >
                          Дахин оролдох
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </section>

        {hasTranslations && (
          <section className="mt-8 overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
            <div className="flex flex-col gap-1 border-b border-stone-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <h2 className="text-lg font-bold">Орчуулгын урьдчилсан харагдац</h2>
                <p className="text-sm text-stone-500">Хадмалын дугаар, хугацаа өөрчлөгдөөгүй.</p>
              </div>
              <span className="text-sm text-stone-500">{Object.keys(translations).length} / {cues.length} мөр</span>
            </div>
            <div className="divide-y divide-stone-200">
              {cues.map((cue, index) => (
                <div key={`${cue.index}-${index}`} className="grid gap-3 p-4 sm:grid-cols-2 sm:gap-5 sm:p-5">
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
                      {cue.index} · {cue.start} → {cue.end} · English
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-stone-700">{cue.text}</p>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Монгол
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {translations[index] ?? (
                        <span className="text-stone-400">Орчуулгыг хүлээж байна…</span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-6 text-center text-xs leading-5 text-stone-500">
          Нууц үг таны хөтөчид хадгалагдана. Файлын агуулгыг зөвхөн орчуулгын хүсэлтээр илгээнэ.
        </p>
      </div>
    </main>
  );
}
