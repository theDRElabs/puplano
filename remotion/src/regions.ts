type Bounds = [number, number, number, number];

const REGIONS: Record<string, Bounds> = {
  world: [-180, -60, 180, 85],
  europe: [-25, 34, 45, 72],
  asia: [25, -10, 150, 55],
  africa: [-20, -36, 55, 38],
  "north america": [-170, 7, -50, 75],
  "south america": [-85, -57, -33, 14],
  oceania: [110, -50, 180, 0],
  "middle east": [25, 12, 65, 42],
  "southeast asia": [92, -11, 142, 28],
  "east asia": [100, 20, 146, 50],
  "latin america": [-120, -56, -34, 33],
  "united states": [-125, 24, -66, 50],
  canada: [-141, 41, -52, 70],
  mexico: [-118, 14, -86, 33],
  brazil: [-74, -34, -34, 6],
  china: [73, 18, 135, 54],
  india: [67, 6, 98, 36],
  japan: [128, 30, 146, 46],
  russia: [27, 41, 180, 78],
  australia: [112, -44, 154, -10],
  "united kingdom": [-11, 49, 2, 61],
  germany: [5, 47, 16, 55],
  france: [-5, 41, 10, 51.5],
};

export const regionBounds = (region: string): Bounds | undefined => {
  const key = region.trim().toLowerCase();
  return REGIONS[key];
};
