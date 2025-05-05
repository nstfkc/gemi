import { Email } from "gemi/email";

import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "jsx-email";
import { BrainIcon } from "lucide-react";

const baseUrl = process.env.HOST_NAME;

export class WelcomeEmail extends Email {
  subject = "Welcome to our platform";

  template = (props: { name: string; magicLink: string; pin: string }) => {
    return (
      <Html>
        <Head />
        <Body style={main}>
          <Preview>{props.name}, welcome to our platform!</Preview>
          <Container style={container}>
            <Section style={box}>
              <BrainIcon size={24} />
              <Hr style={hr} />

              <Text style={paragraph}>
                You can view your payments and a variety of other information
                about your account right from your dashboard.
              </Text>
              <Text>{props.pin}</Text>
              <Button style={button} href={props.magicLink}>
                View your Brain.co Dashboard
              </Button>
              <Text style={paragraph}>— The Brain.co team</Text>
              <Hr style={hr} />
              <Text style={footer}>
                Brain.co, 54 Oyster Point Blvd, South San Francisco, CA 94080
              </Text>
            </Section>
          </Container>
        </Body>
      </Html>
    );
  };
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "20px 0 48px",
  marginBottom: "64px",
};

const box = {
  padding: "0 48px",
};

const hr = {
  borderColor: "#e6ebf1",
  margin: "20px 0",
};

const paragraph = {
  color: "#525f7f",

  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left" as const,
};

const button = {
  backgroundColor: "#030303",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "bold",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "10px",
};

const footer = {
  color: "#8898aa",
  fontSize: "12px",
  lineHeight: "16px",
};
