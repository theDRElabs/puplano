// Frame math shared by the EDL renderer and the pure render tests. These
// helpers intentionally mirror the rounding StoryboardVideo has always used so
// switching a project to the timeline cannot shift a cut by a frame.

export type ClipFrameRange = {
  from: number;
  durationInFrames: number;
};

/** Milliseconds to a composition frame, using the storyboard's rounding. */
export const msToFrame = (ms: number, fps: number): number =>
  Math.round((ms * fps) / 1000);

/** Sequence placement for a clip that spans startMs-endMs. */
export const clipFrames = (
  startMs: number,
  endMs: number,
  fps: number,
): ClipFrameRange => {
  const from = msToFrame(startMs, fps);
  const end = msToFrame(endMs, fps);
  return { from, durationInFrames: Math.max(1, end - from) };
};

/** Total composition frames for a timeline duration. */
export const totalFrames = (durationMs: number, fps: number): number =>
  Math.max(1, msToFrame(durationMs, fps));
