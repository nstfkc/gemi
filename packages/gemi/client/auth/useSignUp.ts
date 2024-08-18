import { useMutation } from "../useMutation";

export function useSignUp() {
  return useMutation("POST:/auth/sign-up", {});
}
