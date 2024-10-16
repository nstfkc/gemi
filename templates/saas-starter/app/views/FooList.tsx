import { usePost, useQuery } from "gemi/client";

export default function FooList() {
  const { trigger, formData } = usePost("/foo");
  const handlePost = async () => {
    formData.append("name", "foo");
    await trigger();
  };

  return (
    <div>
      <button onClick={() => handlePost()}>Submit</button>
    </div>
  );
}
