export type KeyAndValue<K extends PropertyKey, V> = {
  key: K;
  value: V;
};

export type KeyAndValueToObject<TUnion extends KeyAndValue<any, any>> = {
  [T in TUnion as T["key"]]: T["value"];
};
