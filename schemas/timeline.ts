import { z } from "zod";
import { WordSpan } from "./storyboard";

const SceneSpan = z.object({
  startSceneId: z.string().min(1),
  endSceneId: z.string().min(1),
});

const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");

const TRANSITION_TYPES = [
  "cut",
  "fade",
  "slide_left",
  "slide_up",
] as const;

const TEMPLATES = [
  "kinetic_title",
  "stat_counter",
  "chart",
  "timeline",
  "map",
  "quote_cutout",
  "image_zoom",
  "video_clip",
] as const;

const OVERLAY_KINDS = ["source_caption", "lower_third", "label"] as const;

export const Transition = z.object({
  type: z.enum(TRANSITION_TYPES),
  durationMs: z.number().int().min(0).max(2000),
  // V1 keeps clips tiled edge-to-edge. A later renderer can spend this overlap
  // budget on a transition without changing the clip timing model.
  overlapMs: z.number().int().min(0).max(2000).default(0),
});

export const Effect = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const VideoClip = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  template: z.enum(TEMPLATES),
  layout: z.number().int().min(1).max(3),
  props: z.record(z.string(), z.unknown()),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  anchor: WordSpan.optional(),
  holdMs: z.number().int().min(0).max(2000).optional(),
  transitionIn: Transition.optional(),
  effects: z.array(Effect).optional(),
});

export const OverlayClip = z.object({
  id: z.string().min(1),
  kind: z.enum(OVERLAY_KINDS),
  text: z.string().min(1).max(120),
  position: z.enum(["top", "bottom"]).default("bottom"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  anchor: z.union([WordSpan, SceneSpan]).optional(),
  span: z.literal("full").optional(),
});

export const AudioClip = z.object({
  id: z.string().min(1),
  kind: z.enum(["narration", "music"]),
  file: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  sourceInMs: z.number().int().min(0).default(0),
  sourceOutMs: z.number().int().positive(),
  gain: z.number().min(0).max(1).default(1),
  ducking: z
    .object({
      gain: z.number().min(0).max(1),
      whenNarration: z.boolean().default(true),
    })
    .optional(),
  fade: z
    .object({
      inMs: z.number().int().min(0).default(0),
      outMs: z.number().int().min(0).default(0),
    })
    .optional(),
});

export const VideoTrack = z.object({
  kind: z.literal("video"),
  id: z.string().min(1),
  role: z.enum(["program", "broll"]),
  clips: z.array(VideoClip).min(1),
});

export const OverlayTrack = z.object({
  kind: z.literal("overlay"),
  id: z.string().min(1),
  clips: z.array(OverlayClip).min(1),
});

export const AudioTrack = z.object({
  kind: z.literal("audio"),
  id: z.string().min(1),
  clips: z.array(AudioClip).min(1),
});

export const Track = z.discriminatedUnion("kind", [
  VideoTrack,
  OverlayTrack,
  AudioTrack,
]);

export const Marker = z.object({
  atMs: z.number().int().min(0),
  kind: z.enum(["chapter", "beat", "cue"]),
  label: z.string().min(1),
  chapterId: z.string().min(1).optional(),
});

export const TimelineMetadata = z.object({
  styleId: z.string().min(1),
  project: z.string().min(1),
  sourceHashes: z.object({
    script: Sha256,
    words: Sha256,
    storyboard: Sha256,
  }),
  compiler: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  schemaVersion: z.literal(1),
});

export const Timeline = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    durationMs: z.number().int().positive(),
    fps: z.literal(30),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    tracks: z.array(Track).min(1),
    markers: z.array(Marker).default([]),
    metadata: TimelineMetadata,
  })
  .superRefine((timeline, ctx) => {
    const bad = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });

    const programTracks = timeline.tracks.filter(
      (track) => track.kind === "video" && track.role === "program",
    );
    if (programTracks.length !== 1) {
      bad(
        `timeline must have exactly one program video track, found ${programTracks.length}`,
        ["tracks"],
      );
    }

    const trackIds = new Set<string>();
    timeline.tracks.forEach((track, trackIndex) => {
      if (trackIds.has(track.id)) {
        bad(`duplicate track id: ${track.id}`, ["tracks", trackIndex, "id"]);
      }
      trackIds.add(track.id);

      track.clips.forEach((clip, clipIndex) => {
        const path = ["tracks", trackIndex, "clips", clipIndex];
        if (clip.endMs <= clip.startMs) {
          bad(
            `${track.kind} clip ${clip.id}: endMs must be after startMs`,
            [...path, "endMs"],
          );
        }
        if (clip.endMs > timeline.durationMs) {
          bad(
            `${track.kind} clip ${clip.id}: ends at ${clip.endMs} ms, past the timeline duration ${timeline.durationMs} ms`,
            [...path, "endMs"],
          );
        }
      });

      if (track.kind === "audio") {
        track.clips.forEach((clip, clipIndex) => {
          if (clip.sourceOutMs <= clip.sourceInMs) {
            bad(
              `audio clip ${clip.id}: sourceOutMs must be after sourceInMs`,
              ["tracks", trackIndex, "clips", clipIndex, "sourceOutMs"],
            );
          }
        });
      }

      if (track.kind !== "video" || track.role !== "program") return;

      let cursor = 0;
      track.clips.forEach((clip, clipIndex) => {
        if (clip.startMs !== cursor) {
          const gap = clip.startMs > cursor;
          bad(
            `video track ${track.id}: clip ${clip.id} starts at ${clip.startMs} ms, expected ${cursor} ms (${gap ? "gap" : "overlap"})`,
            ["tracks", trackIndex, "clips", clipIndex, "startMs"],
          );
        }
        cursor = clip.endMs;
      });
      if (cursor !== timeline.durationMs) {
        bad(
          `video track ${track.id}: clips end at ${cursor} ms, expected timeline duration ${timeline.durationMs} ms`,
          ["tracks", trackIndex, "clips"],
        );
      }
    });

    timeline.markers.forEach((marker, markerIndex) => {
      if (marker.atMs > timeline.durationMs) {
        bad(
          `marker ${marker.label}: atMs ${marker.atMs} is past the timeline duration ${timeline.durationMs} ms`,
          ["markers", markerIndex, "atMs"],
        );
      }
    });
  });

export type Timeline = z.infer<typeof Timeline>;
export type Track = z.infer<typeof Track>;
export type VideoTrack = z.infer<typeof VideoTrack>;
export type OverlayTrack = z.infer<typeof OverlayTrack>;
export type AudioTrack = z.infer<typeof AudioTrack>;
export type VideoClip = z.infer<typeof VideoClip>;
export type OverlayClip = z.infer<typeof OverlayClip>;
export type AudioClip = z.infer<typeof AudioClip>;
export type Transition = z.infer<typeof Transition>;
export type Marker = z.infer<typeof Marker>;
export type TimelineMetadata = z.infer<typeof TimelineMetadata>;
