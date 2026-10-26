import React from "react";
import { Composition } from "remotion";
import { KineticTitle } from "./templates/KineticTitle";
import { StatCounter } from "./templates/StatCounter";
import { Chart } from "./templates/Chart";
import { Timeline } from "./templates/Timeline";
import { MapScene } from "./templates/MapScene";
import { QuoteCutout } from "./templates/QuoteCutout";
import { ImageZoom } from "./templates/ImageZoom";
import { StoryboardVideo, type StoryboardProps } from "./StoryboardVideo";

const storyboardDefaults: StoryboardProps = {
  title: "Test",
  durationMs: 5000,
  overlays: [],
  scenes: [
    {
      id: "s1",
      template: "kinetic_title",
      layout: 1,
      startMs: 0,
      endMs: 5000,
      props: { text: "Test" },
    },
  ],
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="KineticTitle"
        component={KineticTitle}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ text: "Where does the money go?", subtext: "A test of the first template", layout: 1 }}
      />
      <Composition
        id="StatCounter"
        component={StatCounter}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ value: 4800, prefix: "$", suffix: "", decimals: 0, label: "A test of the stat counter", layout: 1 }}
      />
      <Composition
        id="Chart"
        component={Chart}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ title: "A test chart", data: [{ label: "2021", value: 20 }, { label: "2022", value: 35 }, { label: "2023", value: 50 }, { label: "2024", value: 80 }], unit: "%", layout: 1 }}
      />
      <Composition
        id="Timeline"
        component={Timeline}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ title: "A test timeline", events: [{ date: "1971", label: "First event" }, { date: "1987", label: "Second event" }, { date: "2008", label: "Third event" }, { date: "2020", label: "Fourth event" }], layout: 1 }}
      />
      <Composition
        id="MapScene"
        component={MapScene}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ title: "A test map", highlight: ["United States of America", "United Kingdom"], pins: [{ name: "New York", lon: -74, lat: 40.7 }, { name: "London", lon: -0.1, lat: 51.5 }, { name: "Dubai", lon: 55.3, lat: 25.2 }, { name: "Singapore", lon: 103.8, lat: 1.35 }], layout: 1 }}
      />
      <Composition
        id="QuoteCutout"
        component={QuoteCutout}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ quote: "This is a placeholder quote to test the layout of the template.", author: "Jane Example", role: "Placeholder role", highlight: "placeholder quote", layout: 1 }}
      />
      <Composition
        id="ImageZoom"
        component={ImageZoom}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ image: "test.jpg", caption: "A test caption for the image", source: "Test image made with ffmpeg", layout: 1 }}
      />
      <Composition
        id="StoryboardVideo"
        component={StoryboardVideo}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={storyboardDefaults}
        calculateMetadata={({ props }) => {
          const video = props.style?.video;
          const fps = video?.fps ?? 30;
          return {
            fps,
            width: video?.width ?? 1920,
            height: video?.height ?? 1080,
            durationInFrames: Math.max(1, Math.round((props.durationMs * fps) / 1000)),
          };
        }}
      />
    </>
  );
};
