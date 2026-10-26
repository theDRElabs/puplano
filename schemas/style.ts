import { z } from "zod";

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex colour");

const Rgb = z.tuple([z.number(), z.number(), z.number()]);
const Unit = z.number().min(0).max(1);

export const StyleProfile = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  video: z.object({
    fps: z.union([z.literal(24), z.literal(30)]),
    width: z.literal(1920),
    height: z.literal(1080),
    safeAreaPct: z.number().min(0).max(20),
  }),
  palette: z.object({
    background: HexColor,
    foreground: HexColor,
    accent: HexColor,
    muted: HexColor,
  }),
  typography: z.object({
    displayFont: z.string().min(1),
    bodyFont: z.string().min(1),
    captionFont: z.string().min(1),
    captionSizePx: z.number().int().min(20).max(120),
    captionColor: HexColor,
    captionBackground: HexColor,
    captionBackgroundOpacity: Unit,
    labelColor: HexColor,
    labelBackground: HexColor,
    labelBackgroundOpacity: Unit,
    labelPosition: z.literal("lower_left"),
  }),
  grade: z.object({
    meanRgb: Rgb,
    medianLuma: z.number(),
    saturation: z.number(),
    grain: Unit,
    vignette: Unit,
  }),
  pacing: z.object({
    wpmSpoken: z.number().positive(),
    wpmTotal: z.number().positive(),
    silenceRatio: Unit,
    pausesPerMinute: z.number().nonnegative(),
    pauseMedianMs: z.number().nonnegative(),
    pauseP90Ms: z.number().nonnegative(),
    sentenceMinMs: z.number().nonnegative(),
    sentenceMaxMs: z.number().nonnegative(),
    beatMs: z.tuple([z.number().positive(), z.number().positive()]),
    cutsPerMinute: z.number().nonnegative(),
    medianShotMs: z.number().nonnegative(),
    minShotMs: z.number().nonnegative(),
    longShotShare: Unit,
    cutOnSentenceEnd: Unit,
    holdsUpToMs: z.number().nonnegative(),
    curve: z.array(z.string().min(1)).min(1),
  }),
  captions: z.object({
    maxWords: z.number().int().min(1),
    maxMs: z.number().int().positive(),
    position: z.literal("bottom"),
    nameLabel: z.boolean(),
  }),
});

export type StyleProfile = z.infer<typeof StyleProfile>;
