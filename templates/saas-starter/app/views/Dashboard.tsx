import { useRouter, useSignOut, useUser } from "gemi/client";

export default function Dashboard() {
  const { push } = useRouter();
  const user = useUser();
  const { trigger } = useSignOut({ onSuccess: () => push("/auth/sign-in") });
  return (
    <div>
      <h1>Dashboard</h1>
      <p>Dashboard content goes here</p>
      <div>{user?.name}</div>

      <div>
        <button onClick={() => trigger()}>Sign out</button>
      </div>
    </div>
  );
}
