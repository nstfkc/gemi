import type { ComponentProps } from "react";

const defaultScreen = [390, 768, 1024];
const defaultContainer = [100, 100, 100, 100];

function generateImageProps(
  src: string,
  width: number,
  container = defaultContainer,
  screen = defaultScreen,
  quality: number,
) {
  const baseUrl = src;

  const widths = [...container.map((c, i) => (screen[i] * c) / 100), width * 2];

  return {
    srcSet: [
      ...screen.map((size, i) => {
        return `/api/__gemi__/services/image/resize?url=${baseUrl}&q=${quality}&w=${widths[i]} ${size}${isNaN(Number(size)) ? "" : "w"}`;
      }),
      `/api/__gemi__/services/image/resize?url=${baseUrl}&q=${quality}&w=${width * 2} 2x`,
    ].join(", "),
    sources: [
      ...container.map((c, i) => {
        if (!screen[i]) {
          return `${c}vw`;
        }
        return `(max-width: ${screen[i]}px) ${c}vw`;
      }),
    ].join(", "),
  };
}

function fillRestWithLast<T>(arr: T[], length: number): T[] {
  return [
    ...arr,
    ...Array.from({ length: length - arr.length }).fill(arr[arr.length - 1]),
  ] as T[];
}

interface ImageProps {
  src: string;
  width: number;
  container?: number[];
  screen?: number[];
  quality?: number;
}

export const Image = (props: ComponentProps<"img"> & ImageProps) => {
  const {
    screen = defaultScreen,
    container = defaultContainer,
    src,
    width,
    quality = 80,
    srcSet: __,
    ...rest
  } = props;

  if (!src) {
    return null;
  }

  const srcProps = generateImageProps(
    src,
    width,
    fillRestWithLast(container, 4),
    screen,
    quality,
  );

  return <img {...srcProps} width={width} {...rest} />;
};
