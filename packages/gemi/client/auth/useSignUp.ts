import { useMutation } from "../useMutation";

export function useSignUp() {
  return useMutation("POST:/sign-up", {}, { pathPrefix: "/auth" });
}
