import React from "react";
import { Chart } from "./templates/Chart";
import { ImageZoom } from "./templates/ImageZoom";
import { KineticTitle } from "./templates/KineticTitle";
import { MapScene } from "./templates/MapScene";
import { QuoteCutout } from "./templates/QuoteCutout";
import { StatCounter } from "./templates/StatCounter";
import { Timeline } from "./templates/Timeline";
import { regionBounds } from "./regions";

export type Scene = {
  id: string;
  template: string;
  layout: number;
  startMs: number;
  endMs: number;
  transitionIn?: { type: string; durationMs: number };
  props: any;
};

const sourceText = (lic: any): string | undefined => {
  if (!lic) return undefined;
  let host = "";
  try { host = new URL(lic.sourceUrl).hostname; } catch {}
  return [lic.type, host].filter(Boolean).join(" · ");
};

export const renderTemplate = (s: Scene): React.ReactElement => {
  const p = s.props;
  const layout = s.layout as 1 | 2 | 3;
  switch (s.template) {
    case "kinetic_title":
      return <KineticTitle text={p.text} subtext={p.subtext} layout={layout} />;
    case "stat_counter":
      return <StatCounter value={p.to} from={p.from} prefix={p.prefix} suffix={p.suffix} decimals={p.decimals} label={p.label} layout={layout} />;
    case "chart":
      return <Chart title={p.title} data={p.data} unit={p.unit} layout={p.kind === "line" ? 3 : s.layout === 2 ? 2 : 1} />;
    case "timeline":
      return <Timeline title="" events={p.events} layout={layout} />;
    case "map":
      return <MapScene title={p.caption ?? ""} highlight={p.highlights ?? []} pins={[]} bounds={regionBounds(p.region)} layout={layout} />;
    case "quote_cutout":
      return <QuoteCutout quote={p.quote} author={p.attribution} image={p.imageFile} layout={layout} />;
    case "image_zoom":
      return <ImageZoom image={p.imageFile} caption={p.caption} source={sourceText(p.license)} layout={layout} />;
    default:
      throw new Error("Unknown template: " + s.template);
  }
};
