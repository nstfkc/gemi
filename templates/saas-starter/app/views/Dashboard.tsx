import { useBroadcast, useSubscription } from "gemi/client";
import { useState } from "react";

export default function Dashboard() {
  const broadcast = useBroadcast("/foo/:id", { params: { id: 1 } });

  return (
    <div className="p-4">
      <h1>Dashboard</h1>
      <div>Hello</div>

      <button onClick={() => broadcast({ message: "increment" })}>
        Increment
      </button>
    </div>
  );
}
