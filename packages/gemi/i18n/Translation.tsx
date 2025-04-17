import type { PropsWithChildren } from "react";

interface Props<T> {
  context: T;
  key: keyof T;
  render?: (props: PropsWithChildren) => React.JSX.Element;
  transform?: {
    [K in keyof T]: (arg: T[K]) => string;
  };
}

export function Translation<T>(props: Props<T>) {
  const {
    context,
    render = (props: PropsWithChildren) => <span>{props.children}</span>,
    transform,
  } = props;
  const Component = render;
  return <Component>{}</Component>;
}
