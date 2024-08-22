import { usePost } from "../useMutation";

export function useSignUp() {
  return usePost("/auth/sign-up");
}
