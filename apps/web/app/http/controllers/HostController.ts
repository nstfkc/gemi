import { prisma } from "@/app/database/prisma";
import { AppointmentConfirmedByHostEmail } from "@/app/emails/AppointmentConfirmedByHostEmail";
import { Controller, type HttpRequest } from "gemi/http";
import { format } from "date-fns";

export class HostController extends Controller {
  async list() {
    const hosts = await prisma.host.findMany({
      include: {
        address: true,
        Appointment: true,
        HostProducts: {
          include: {
            Product: true,
          },
        },
      },
    });

    return {
      data: { hosts },
    };
  }

  async appointment(req: HttpRequest, params: { appointmentId: string }) {
    const { appointmentId } = params;

    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
      },
      include: {
        host: true,
        product: true,
        visitor: true,
      },
    });

    return {
      data: {
        appointment,
      },
    };
  }

  async approveAppointment(
    req: HttpRequest,
    params: { appointmentId: string },
  ) {
    const appointment = await prisma.appointment.update({
      where: { id: params.appointmentId },
      data: {
        status: 1,
      },
      include: {
        host: true,
      },
    });

    if (appointment) {
      const email = new AppointmentConfirmedByHostEmail({
        subject: "Your appointment is confirmed",
        to: appointment.host.email,
        props: {
          name: appointment.host.name,
          date: format(new Date(appointment.date), "dd/MM/yyyy"),
          alternativeDate: format(
            new Date(appointment.alternativeDate),
            "dd/MM/yyyy",
          ),
          url: `${process.env.HOST_NAME}/visitor/appointment/${appointment.id}`,
        },
      });
      await email.send();
    }

    return {
      data: {
        success: true,
      },
    };
  }
}
