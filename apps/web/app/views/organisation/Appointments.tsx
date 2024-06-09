import { Spacer } from "@nextui-org/react";
import { format } from "date-fns";

import {
  Table,
  TableHeader,
  TableBody,
  TableColumn,
  TableRow,
  TableCell,
} from "@nextui-org/table";

import type { Appointment, Host, Product, Visitor } from "@prisma/client";

export default function Appointments(props: {
  appointments: (Appointment & {
    host: Host;
    visitor: Visitor;
    product: Product;
  })[];
}) {
  const { appointments } = props;
  return (
    <div>
      <h1 className="font-semibold text-lg">Appointments</h1>
      <Spacer y={3} />
      <div>
        <Table aria-label="Hosts table">
          <TableHeader>
            <TableColumn>Host</TableColumn>
            <TableColumn>Visitor</TableColumn>
            <TableColumn>Product</TableColumn>
            <TableColumn>Appointment Dates</TableColumn>
            <TableColumn>Status</TableColumn>
            <TableColumn>Created at</TableColumn>
          </TableHeader>
          <TableBody>
            {appointments.map((appointment) => (
              <TableRow key={appointment.id}>
                <TableCell>{appointment.host.name}</TableCell>
                <TableCell>
                  {appointment.visitor.firstName} {appointment.visitor.lastName}
                </TableCell>
                <TableCell>{appointment.product.name}</TableCell>
                <TableCell>
                  <div>{format(new Date(appointment.date), "dd.mm.yyyy")}</div>
                  <div>
                    {format(
                      new Date(appointment.alternativeDate),
                      "dd.mm.yyyy",
                    )}
                  </div>
                </TableCell>
                <TableCell>{appointment.status}</TableCell>
                <TableCell>
                  {format(new Date(appointment.createdAt), "dd.mm.yyyy")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
