import { Spacer } from "@nextui-org/react";
import {
  Table,
  TableHeader,
  TableBody,
  TableColumn,
  TableRow,
  TableCell,
} from "@nextui-org/table";

import type { Host } from "@prisma/client";

export default function Hosts(props: { hosts: Host[] }) {
  const { hosts } = props;
  return (
    <div>
      <h1 className="font-semibold text-lg">Hosts</h1>
      <Spacer y={3} />
      <Table aria-label="Hosts table">
        <TableHeader>
          <TableColumn>Name</TableColumn>
          <TableColumn>Email</TableColumn>
          <TableColumn>Phone</TableColumn>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.id}>
              <TableCell>{host.name}</TableCell>
              <TableCell>{host.email}</TableCell>
              <TableCell>{host.phone}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
