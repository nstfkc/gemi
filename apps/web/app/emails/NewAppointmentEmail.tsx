import { Email } from "@/framework/Email";
import { Html, Button, Text, Heading } from "@react-email/components";

export class NewAppointmentEmail extends Email {
  render(props: {
    url: string;
    date: string;
    name: string;
    alternativeDate: string;
  }) {
    return (
      <Html lang="en">
        <Text>
          <Heading>New Appointment</Heading>
          <Text>
            You have a new appointment with {props.name} on {props.date} or
            alternatively {props.alternativeDate}
          </Text>
          <Text>
            Click this button to approve your appointment or propose an
            alternative date.
          </Text>
          <Button href={props.url}>View Appointment</Button>
        </Text>
      </Html>
    );
  }
}
