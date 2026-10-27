import { z } from "zod";

export const PauseKind = z.enum([
  "act-break",
  "paragraph-break",
  "reveal",
  "beat",
  "breath",
]);

export const DirectedPause = z.object({
  afterSentence: z.number().int().positive(),
  afterWordId: z.string().regex(/^w\d{4,}$/, "must be a word id such as w0019"),
  afterText: z.string().min(1),
  targetGapMs: z.number().int().min(250).max(3000),
  kind: PauseKind,
  reason: z.string().min(8),
});

export const PauseDirection = z
  .object({
    version: z.literal(1),
    generatedBy: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    pauses: z.array(DirectedPause).min(8).max(11),
    metrics: z
      .object({
        sentenceCount: z.number().int().positive(),
        pauseCount: z.number().int().positive(),
        totalPauseMs: z.number().int().nonnegative(),
        medianGapMs: z.number().int().nonnegative(),
        longBeats: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<number>();
    let previous = 0;
    data.pauses.forEach((pause, index) => {
      if (pause.afterSentence <= previous) {
        ctx.addIssue({
          code: "custom",
          message: "pauses must be ordered by ascending afterSentence",
          path: ["pauses", index, "afterSentence"],
        });
      }
      previous = pause.afterSentence;
      if (seen.has(pause.afterSentence)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate pause afterSentence ${pause.afterSentence}`,
          path: ["pauses", index, "afterSentence"],
        });
      }
      seen.add(pause.afterSentence);
    });
  });

export type PauseDirection = z.infer<typeof PauseDirection>;
export type DirectedPause = z.infer<typeof DirectedPause>;
export type PauseKind = z.infer<typeof PauseKind>;
