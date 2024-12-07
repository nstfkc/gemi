export function createStyles(styles) {
  return styles.map((style, i) => {
    if (style.isDev) {
      return (
        <style key={style.id} type="text/css" data-vite-dev-id={style.id}>
          {style.content}
        </style>
      );
    } else {
      return (
        <style key={i} id={style?.id} type="text/css">
          {style.content}
        </style>
      );
    }
  });
}
