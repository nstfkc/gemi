import {
  Form,
  Link,
  useDelete,
  useMutation,
  usePatch,
  usePost,
  useQuery,
  useSearchParams,
  useSubscription,
  useUser,
  type ViewProps,
} from "gemi/client";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();

  const {
    data: colors,
    mutate,
    loading,
  } = useQuery(
    "/home",
    {
      search: { color: searchParams.get("color") },
    },
    { keepPreviousData: true },
  );

  useSubscription("/foo/:id", {
    params: { id: 1 },
    cb: (data) => console.log(data),
  });

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, translateY: 0 }}
        animate={{ opacity: 1, translateY: 20 }}
        exit={{ opacity: 0, translateY: 0 }}
      >
        <div className="flex gap-2">
          {props.filters.map((filter) => (
            <Link
              key={filter}
              className="data-[active=true]:underline"
              href="/"
              search={{ color: filter }}
            >
              {filter}
            </Link>
          ))}
        </div>

        <div>
          {colors?.map((color) => (
            <div
              key={color.hex}
              style={{ backgroundColor: color.hex, width: 100, height: 100 }}
            />
          ))}
        </div>
        <button
          onClick={() => {
            mutate([
              {
                id: 5,
                name: "Purple",
                hex: "#800080",
                color: "purple",
              },
            ]);
          }}
        >
          Mutate
        </button>
        <div className="space-y-4">
          {Array.from(Array(100))
            .fill("_")
            .map((_, i) => {
              return (
                <div key={i} className="h-[200px] w-full bg-red-100">
                  {i}
                </div>
              );
            })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
