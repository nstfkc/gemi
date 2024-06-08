import { prisma } from "@/app/database/prisma";
import { NewAppointmentEmail } from "@/app/emails/NewAppointmentEmail";
import { Controller, HttpRequest } from "gemi/http";
import { format } from "date-fns";

type CreateAppointmentInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  zipCode: string;
  date: Date;
  alternativeDate: Date;
  preferredTimeWindow: string[];
  productId: string;
};

class CreateAppointmentRequest extends HttpRequest<CreateAppointmentInput> {
  schema = {
    firstName: { required: "First name is required" },
    lastName: { required: "Last name is required" },
    email: { required: "Email is required" },
    phone: { required: "Phone is required" },
    zipCode: { required: "Zip code is required" },
    date: { required: "Date is required" },
    alternativeDate: { required: "Alternative date is required" },
    preferredTimeWindow: { required: "Preferred time window is required" },
  };
}

export class AppointmentController extends Controller {
  requests = {
    create: CreateAppointmentRequest,
  };

  async show(req: HttpRequest, params: { organisationId: string }) {
    const { organisationId } = params;
    const appointments = await prisma.appointment.findMany({
      where: {
        host: {
          organizationId: organisationId,
        },
      },
      include: {
        host: true,
        visitor: true,
        product: true,
      },
    });

    return {
      data: {
        appointments,
        test: "hi",
      },
    };
  }

  async create(req: CreateAppointmentRequest, params: { hostId: string }) {
    const input = await req.input();
    const {
      alternativeDate,
      date,
      email,
      firstName,
      lastName,
      phone,
      preferredTimeWindow,
      productId,
      zipCode,
    } = input.toJSON();
    const { hostId } = params;

    let visitor = await prisma.visitor.findFirst({
      where: {
        email,
        phone,
        zipCode,
      },
    });

    if (!visitor) {
      visitor = await prisma.visitor.create({
        data: {
          email,
          firstName,
          lastName,
          phone,
          zipCode,
          communityLetterAccepted: true,
        },
      });
    }

    const appointment = await prisma.appointment.create({
      data: {
        hostId,
        date: new Date(date).toISOString(),
        alternativeDate: new Date(alternativeDate).toISOString(),
        preferredTimeWindow: preferredTimeWindow.join(","),
        productId,
        visitorId: visitor.id,
      },
      include: {
        host: true,
        visitor: true,
        product: true,
      },
    });

    if (appointment) {
      const email = new NewAppointmentEmail({
        to: appointment.host.email,
        subject: `New appointment for the product ${appointment.product.name}`,
        props: {
          name: appointment.visitor.firstName,
          date: format(new Date(appointment.date), "dd/MM/yyyy"),
          alternativeDate: format(
            new Date(appointment.alternativeDate),
            "dd/MM/yyyy",
          ),
          url: `${process.env.HOST_NAME}/host/appointment/${appointment.id}`,
        },
      });
      await email.send();
      return {
        data: {
          message: "Hello World",
        },
      };
    }

    return {
      data: {
        appointment,
      },
    };
  }
}
