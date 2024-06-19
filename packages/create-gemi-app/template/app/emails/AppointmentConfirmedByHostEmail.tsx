import { Email } from "gemi/email";
import { Html, Button, Text, Heading } from "@react-email/components";

export class AppointmentConfirmedByHostEmail extends Email {
  render(props: {
    url: string;
    date: string;
    name: string;
    alternativeDate: string;
  }) {
    return (
      <Html lang="en">
        <Text>
          <Heading as="h1">Your appointment is confirmed</Heading>
          <Text>
            Your appointment with {props.name} on {props.date} or alternatively{" "}
            {props.alternativeDate}
          </Text>
          <Text>
            Click this button to approve your appointment or propose an
            alternative date.
          </Text>
          <Button href={props.url}>Confirm Appointment</Button>
        </Text>
      </Html>
    );
  }
}
