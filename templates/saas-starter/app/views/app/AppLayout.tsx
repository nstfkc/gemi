import { Sidebar } from "./components/Sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh min-h-dvh">
      <Sidebar />
      <div>{children}</div>
    </div>
  );
}
