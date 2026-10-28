import type { Storyboard } from "../schemas/storyboard";
import {
  Timeline,
  type AudioClip,
  type Track,
  type Timeline as TimelineType,
} from "../schemas/timeline";

/**
 * Rewrite the project-relative media paths in a compiled timeline to the
 * staged paths produced by stageProjectAssets. Timing, roles, transitions,
 * overlays, markers, and metadata are copied through untouched.
 *
 * Video clips are matched by sceneId, so program and broll tracks both pick up
 * the staged props. Narration always points at the staged storyboard narration;
 * storyboard music is remapped when staging kept it and dropped when optional
 * staging omitted it.
 */
export const remapTimelineAssets = (
  timeline: TimelineType,
  sourceStoryboard: Storyboard,
  stagedStoryboard: Storyboard,
): TimelineType => {
  const stagedScenes = new Map(
    stagedStoryboard.scenes.map((scene) => [scene.id, scene]),
  );

  const tracks: Track[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "video") {
      tracks.push({
        ...track,
        clips: track.clips.map((clip) => {
          const scene = stagedScenes.get(clip.sceneId);
          return scene ? { ...clip, props: { ...scene.props } } : clip;
        }),
      });
      continue;
    }

    if (track.kind === "overlay") {
      tracks.push(track);
      continue;
    }

    const clips: AudioClip[] = [];
    for (const clip of track.clips) {
      if (clip.kind === "narration") {
        clips.push({ ...clip, file: stagedStoryboard.audioFile });
        continue;
      }

      if (clip.kind === "music") {
        // Only treat this as the storyboard's own music. Leave unrelated music
        // clips (a hand-authored track) alone.
        const isStoryboardMusic =
          !sourceStoryboard.music ||
          clip.file === sourceStoryboard.music.file;
        if (!isStoryboardMusic) {
          clips.push(clip);
          continue;
        }
        if (stagedStoryboard.music) {
          clips.push({ ...clip, file: stagedStoryboard.music.file });
        }
        // Optional staging omits music: drop the clip (and later the track).
        continue;
      }

      clips.push(clip);
    }
    if (clips.length > 0) tracks.push({ ...track, clips });
  }

  return Timeline.parse({ ...timeline, tracks });
};
