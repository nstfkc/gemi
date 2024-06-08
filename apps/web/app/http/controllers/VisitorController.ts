import { prisma } from "@/app/database/prisma";
import { Controller, type HttpRequest } from "gemi/http";

export class VisitorController extends Controller {
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
    await prisma.appointment.update({
      where: { id: params.appointmentId },
      data: {
        status: 2,
      },
    });

    return {
      data: {
        success: true,
      },
    };
  }
}
