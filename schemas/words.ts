import { z } from "zod";

export const WordTiming = z.object({
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
    data.words.forEach((word, index) => {
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
