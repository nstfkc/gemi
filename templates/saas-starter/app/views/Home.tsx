import { useMutation, useQuery } from "gemi/client";

export default function Home() {
  const { data, trigger } = useMutation('PUT:/posts/:id', { params: { id: '1234' } })
  trigger({ title: 'Hello World!' })

  return null
}
