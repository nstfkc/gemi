import { Link, useRouter, useSignOut, useUser } from "gemi/client";

export const Sidebar = () => {
  const user = useUser();
  const { push } = useRouter();
  const { trigger } = useSignOut({ onSuccess: () => push("/auth/sign-in") });
  return (
    <aside className="w-[240px] h-full bg-neutral-50 flex flex-col justify-between">
      <div className="flex flex-col gap-4">
        <div className="p-4">
          <h2 className="font-semibold">Gemi</h2>
        </div>
        <nav className="px-4">
          <Link href="/app/dashboard">Dashboard</Link>
        </nav>
      </div>
      <div className="p-4">
        <div>{user?.name}</div>
        <button className="font-semibold" onClick={() => trigger()}>
          Sign out
        </button>
      </div>
    </aside>
  );
};
