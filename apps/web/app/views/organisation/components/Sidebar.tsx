import { Link, useLocation, useRouter } from "gemi/client";
import type { Organization } from "@prisma/client";
import type { ComponentProps } from "react";

import {
  GaugeIcon,
  CalendarIcon,
  ArmchairIcon,
  LayoutGridIcon,
  WorkflowIcon,
  SettingsIcon,
} from "lucide-react";
import { Button, Spacer } from "@nextui-org/react";
import { useMutation, useUser } from "gemi/client";

const linkClassName = [
  "flex items-center gap-2",
  "data-[active=true]:bg-gray-200",
  "data-[active=false]:opacity-75 data-[active=false]:hover:opacity-100",
  "rounded-lg px-4 py-2",
  "text-sm font-medium",
].join(" ");

const SidebarLink = (props: ComponentProps<typeof Link>) => {
  const { pathname } = useLocation();

  return (
    <Link
      data-active={pathname === props.href}
      {...props}
      className={linkClassName}
    />
  );
};

export const Sidebar = (props: { organisation: Organization }) => {
  const { organisation } = props;

  const { trigger } = useMutation("/auth/sign-out");
  const { name, email } = useUser();
  const { push } = useRouter();

  return (
    <div className="p-4 flex flex-col h-full justify-between">
      <div className="grow">
        <div className="flex items-center gap-2 px-2">
          <div className="rounded-lg size-8 bg-gray-700 border border-2 border-gray-800"></div>
          <span className="font-semibold">{organisation.name}</span>
        </div>
        <div className="h-6"></div>
        <div className="flex flex-col gap-1 py-4">
          <SidebarLink
            className={linkClassName}
            href={`/organisation/${organisation.id}/dashboard`}
          >
            <GaugeIcon size="16" opacity={0.8} />
            <span>Dashboard</span>
          </SidebarLink>
          <SidebarLink href={`/organisation/${organisation.id}/appointments`}>
            <CalendarIcon size="16" opacity={0.8} />
            <span>Appointments</span>
          </SidebarLink>
          <SidebarLink href={`/organisation/${organisation.id}/hosts`}>
            <ArmchairIcon size="16" opacity={0.8} />
            <span>Hosts</span>
          </SidebarLink>
          <SidebarLink href={`/organisation/${organisation.id}/products`}>
            <LayoutGridIcon size="16" opacity={0.8} />
            <span>Products</span>
          </SidebarLink>
        </div>
        <div className="flex flex-col gap-1 py-4">
          <SidebarLink href={`/organisation/${organisation.id}/integration`}>
            <WorkflowIcon size="16" opacity={0.8} />
            <span>Integration</span>
          </SidebarLink>
          <SidebarLink href={`/organisation/${organisation.id}/settings`}>
            <SettingsIcon size="16" opacity={0.8} />
            <span>Settings</span>
          </SidebarLink>
        </div>
      </div>
      <div>
        <div className="font-medium">{name}</div>
        <div className="text-sm opacity-50">{email}</div>
        <Spacer y={3} />
        <Button
          onClick={() =>
            trigger().then(() => {
              push("/");
            })
          }
        >
          Sign out
        </Button>
      </div>
    </div>
  );
};
