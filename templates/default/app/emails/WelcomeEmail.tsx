import { Email } from "gemi/email";
import { Html, Button, Text, Heading } from "@react-email/components";

export class WelcomeEmail extends Email {
  render(props: {
    url: string;
    date: string;
    name: string;
    alternativeDate: string;
  }) {
    return (
      <Html lang="en">
        <Text>
          <Heading>Welcome</Heading>
          <Text>Hi there</Text>
          <Text>
            Click this button to approve your appointment or propose an
            alternative date.
          </Text>
          <Button href={props.url}>Start here</Button>
        </Text>
      </Html>
    );
  }
}
