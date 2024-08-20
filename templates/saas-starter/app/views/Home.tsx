import { useQuery, type ViewProps } from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  const { data: user, mutate } = useQuery(
    "GET:/users",
    {},
    { fallbackData: props.user },
  );

  if (!user) return <div>Loading...</div>;

  return (
    <div>
      <div>{user?.name}</div>
      <div>
        <button
          onClick={() =>
            mutate((user) => (user ? { ...user, name: "Tucker" } : user))
          }
        >
          Mutate
        </button>
      </div>
    </div>
  );
}
