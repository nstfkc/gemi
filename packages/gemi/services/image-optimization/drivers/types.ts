export type FitEnum = {
  contain: "contain";
  cover: "cover";
  fill: "fill";
  inside: "inside";
  outside: "outside";
};

export type ResizeParameters = {
  width: number;
  height: number;
  quality?: number;
  fit?: keyof FitEnum;
};
