import { usePost } from "gemi/client";

export default function Dashboard() {
  const { trigger: logout } = usePost("/auth/sign-out");
  return (
    <div className="p-4">
      <h1>Dashboard</h1>
      <button onClick={() => logout()}>Sign out</button>
    </div>
  );
}
