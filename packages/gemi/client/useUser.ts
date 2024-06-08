import { useContext, useEffect, useState } from "react";
import { ServerDataContext } from "./ServerDataProvider";

export function useUser() {
  const { auth } = useContext(ServerDataContext);
  const [user, setUser] = useState(auth?.user ?? {});

  useEffect(() => {
    if (auth?.user) {
      setUser(auth?.user);
    }
  }, [auth?.user]);

  return user;
}
