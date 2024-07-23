import { useMutation, useQuery } from "gemi/client";

const Component = () => {
  const { data, loading, error, mutate } = useQuery("GET:/posts");
  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {data.message}
      <button onClick={() => mutate(() => ({ message: "Fuck you" }))}>
        Mutate
      </button>
    </div>
  );
};

export default function Home() {
  const { data, loading, error } = useQuery("GET:/posts");

  return (
    <div>
      <Component />
      <Component />
    </div>
  );
}
