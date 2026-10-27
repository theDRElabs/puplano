import { z } from "zod";

// Stable IDs let storyboard anchors survive punctuation/caption edits. The
// voice pipeline assigns them from the global word index (w0001, w0002, ...).
const WordId = z
  .string()
  .regex(/^w\d{4,}$/, "must be a stable word id such as w0001");

export const WordTiming = z.object({
  id: WordId,
  word: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
});

export const WordTimings = z
  .object({
    voiceName: z.string().min(1),
    durationMs: z.number().int().positive(),
    words: z.array(WordTiming).min(1),
  })
  .superRefine((data, ctx) => {
    let previousEnd = 0;
    const ids = new Set<string>();
    data.words.forEach((word, index) => {
      if (ids.has(word.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate word id: ${word.id}`,
          path: ["words", index, "id"],
        });
      }
      ids.add(word.id);
      if (word.endMs <= word.startMs) {
        ctx.addIssue({
          code: "custom",
          message: "endMs must be after startMs",
          path: ["words", index],
        });
      }
      if (word.startMs < previousEnd) {
        ctx.addIssue({
          code: "custom",
          message: "word timings must be ordered and cannot overlap",
          path: ["words", index],
        });
      }
      if (word.endMs > data.durationMs) {
        ctx.addIssue({
          code: "custom",
          message: "word runs past the audio duration",
          path: ["words", index],
        });
      }
      previousEnd = word.endMs;
    });
  });

export type WordTiming = z.infer<typeof WordTiming>;
export type WordTimings = z.infer<typeof WordTimings>;
