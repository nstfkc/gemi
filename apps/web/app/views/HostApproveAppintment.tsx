import { useMutation } from "gemi/client";
import { Button } from "@nextui-org/react";
import type { Appointment, Host, Product } from "@prisma/client";
import { useState } from "react";

interface Props {
  appointment: Appointment & { host: Host; product: Product };
}
export default function HostApproveAppintment(props: Props) {
  const [success, setSuccess] = useState(false);
  const { appointment } = props;
  const { trigger, isPending } = useMutation(
    `/host/appointment/${appointment.id}`,
  );

  if (success) {
    return (
      <div className="container max-w-2xl mx-auto py-16">
        <div>ID: {appointment.id}</div>
        <div>Appointment approved!</div>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto py-16">
      <div>ID: {appointment.id}</div>
      <div>
        <Button
          onPress={() => trigger().then(() => setSuccess(true))}
          isLoading={isPending}
          color="primary"
        >
          Approve appointment
        </Button>
      </div>
    </div>
  );
}
