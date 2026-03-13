import React, { ComponentType, ReactNode, Suspense } from "react";

const I18nDictBoundary = (props: { id: string; children: ReactNode }) => {
  const { children, id } = props;
  return <Suspense name="">{children}</Suspense>;
};
