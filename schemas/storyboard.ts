import { z } from "zod";

const Source = z.object({
  label: z.string().min(1),
  url: z.string().url().optional(),
});

const WordId = z
  .string()
  .regex(/^w\d{4,}$/, "must be a stable word id such as w0001");

// A stable span over voice/words.json. Anchors are resolved by the timing
// compiler, so punctuation and caption edits do not invalidate a storyboard.
export const WordSpan = z.object({
  startWordId: WordId,
  endWordId: WordId,
});

const SceneSpan = z.object({
  startSceneId: z.string().min(1),
  endSceneId: z.string().min(1),
});

// Attribution evidence is mandatory: a media license without a resolvable
// claim URL, a complete attribution line, and a modification note is not
// publishable. `credit` is additionally required when the claim needs it,
// which is enforced by verifyStoryboardMedia because it depends on the claim.
export const License = z.object({
  type: z.string().min(1),
  sourceUrl: z.string().url(),
  credit: z.string().min(1).optional(),
  licenseUrl: z.string().url(),
  attribution: z.string().min(1),
  modifications: z.string().min(1),
});

// How a scene enters (the change from the previous scene)
const Transition = z.object({
  type: z.enum(["cut", "fade", "slide_left", "slide_up"]),
  durationMs: z.number().int().min(0).max(2000),
});

const base = {
  id: z.string().min(1),
  chapter: z.number().int().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  layout: z.number().int().min(1).max(3),
  transitionIn: Transition.optional(),
  narration: z.string().optional(),
  source: Source.optional(),
  // Optional for legacy storyboards; the timing compiler requires anchors for
  // projects that opt into compiled timing.
  anchor: WordSpan.optional(),
  holdMs: z.number().int().min(0).max(2000).optional(),
};

const KineticTitle = z.object({
  ...base,
  template: z.literal("kinetic_title"),
  props: z.object({ text: z.string().min(1), subtext: z.string().optional() }),
});

const StatCounter = z.object({
  ...base,
  template: z.literal("stat_counter"),
  props: z.object({
    label: z.string().min(1),
    from: z.number(),
    to: z.number(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    decimals: z.number().int().min(0).max(4).default(0),
  }),
});

const Chart = z.object({
  ...base,
  template: z.literal("chart"),
  props: z.object({
    kind: z.enum(["bar", "line"]),
    title: z.string().min(1),
    unit: z.string().optional(),
    data: z.array(z.object({ label: z.string(), value: z.number() })).min(2).max(12),
  }),
});

const Timeline = z.object({
  ...base,
  template: z.literal("timeline"),
  props: z.object({
    events: z.array(z.object({ date: z.string(), label: z.string() })).min(2).max(6),
  }),
});

const MapScene = z.object({
  ...base,
  template: z.literal("map"),
  props: z.object({
    region: z.string().min(1),
    highlights: z.array(z.string()).max(8).default([]),
    caption: z.string().optional(),
  }),
});

const QuoteCutout = z.object({
  ...base,
  template: z.literal("quote_cutout"),
  props: z.object({
    quote: z.string().min(1),
    attribution: z.string().min(1),
    imageFile: z.string().optional(),
    license: License.optional(),
  }),
});

const ImageZoom = z.object({
  ...base,
  template: z.literal("image_zoom"),
  props: z.object({
    imageFile: z.string().min(1),
    caption: z.string().optional(),
    license: License,
  }),
});

const VideoClip = z.object({
  ...base,
  template: z.literal("video_clip"),
  props: z.object({
    videoFile: z.string().min(1),
    caption: z.string().optional(),
    startFromMs: z.number().int().min(0).default(0),
    mediaAssetId: z.string().min(1).optional(),
    license: License,
  }),
});

export const Scene = z.discriminatedUnion("template", [
  KineticTitle, StatCounter, Chart, Timeline, MapScene, QuoteCutout, ImageZoom, VideoClip,
]);

// Things drawn ON TOP of scenes. These are allowed to overlap scenes.
export const Overlay = z.object({
  id: z.string().min(1),
  kind: z.enum(["source_caption", "lower_third", "label"]),
  text: z.string().min(1).max(120),
  position: z.enum(["top", "bottom"]).default("bottom"),
  // Numeric timing is filled by the compiler. A storyboard may carry only an
  // anchor or `span: "full"` before it is compiled.
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
  // Optional stable timing. `span: "full"` covers the whole audio track; a
  // scene span follows compiled scene starts/ends.
  anchor: z.union([WordSpan, SceneSpan]).optional(),
  span: z.literal("full").optional(),
});

// Background music: normal volume, and a lower volume while narration plays
const Music = z.object({
  file: z.string().min(1),
  baseVolume: z.number().min(0).max(1),
  duckedVolume: z.number().min(0).max(1),
  fadeMs: z.number().int().min(0).max(3000),
});

export const Storyboard = z
  .object({
    title: z.string().min(1),
    audioFile: z.string().min(1),
    durationMs: z.number().int().positive(),
    scenes: z.array(Scene).min(1),
    overlays: z.array(Overlay).default([]),
    music: Music.optional(),
  })
  .superRefine((sb, ctx) => {
    const bad = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });

    let prevEnd = 0;
    sb.scenes.forEach((s, i) => {
      if (s.endMs <= s.startMs)
        bad(`scene ${s.id}: endMs must be after startMs`, ["scenes", i]);
      if (s.startMs !== prevEnd)
        bad(`scene ${s.id}: must start exactly when the previous scene ends (${prevEnd} ms), no gaps or overlaps`, ["scenes", i]);
      prevEnd = s.endMs;

      // Variety rule: no three scenes in a row with the same template AND layout
      if (i >= 2) {
        const a = sb.scenes[i - 1];
        const b = sb.scenes[i - 2];
        if (s.template === a.template && s.template === b.template && s.layout === a.layout && s.layout === b.layout)
          bad(`scene ${s.id}: same template and layout three times in a row, vary it`, ["scenes", i]);
      }
    });
    if (prevEnd !== sb.durationMs)
      bad(`last scene must end exactly at the audio length (${sb.durationMs} ms), it ends at ${prevEnd} ms`, ["scenes"]);

    sb.overlays.forEach((o, i) => {
      if ((o.startMs === undefined) !== (o.endMs === undefined))
        bad(`overlay ${o.id}: startMs and endMs must be provided together`, ["overlays", i]);
      if (o.startMs === undefined && !o.anchor && !o.span)
        bad(`overlay ${o.id}: needs milliseconds, an anchor, or span "full"`, ["overlays", i]);
      if (o.startMs !== undefined && o.endMs !== undefined) {
        if (o.endMs <= o.startMs) bad(`overlay ${o.id}: endMs must be after startMs`, ["overlays", i]);
        if (o.endMs > sb.durationMs) bad(`overlay ${o.id}: runs past the end of the audio`, ["overlays", i]);
      }
    });

    if (sb.music && sb.music.duckedVolume > sb.music.baseVolume)
      bad("music: duckedVolume must not be louder than baseVolume", ["music"]);
  });

export type Scene = z.infer<typeof Scene>;
export type Overlay = z.infer<typeof Overlay>;
export type WordSpan = z.infer<typeof WordSpan>;
export type License = z.infer<typeof License>;
export type Storyboard = z.infer<typeof Storyboard>;
