import { Html, Button, Text, Heading, Tailwind } from "@react-email/components";

export default function Welcome(props: { name: string }) {
  return (
    <Tailwind>
      <Html lang="en">
        <Text>
          <Heading className="text-red-500">Welcome</Heading>
          <Text>Hi {props.name}</Text>
          <Text>
            Click this button to approve your appointment or propose an
            alternative date.
          </Text>
        </Text>
      </Html>
    </Tailwind>
  );
}
