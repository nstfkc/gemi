import { Html, Button, Text, Heading, Tailwind } from "jsx-email";

export default function Welcome(props: { name: string; locale: string }) {
  const { locale, name } = props;
  if (locale === "en-US") {
    return (
      <Tailwind>
        <Html lang={props.locale}>
          <Text>
            <Heading className="text-red-500">Welcome</Heading>
            <Text>Hi {name},</Text>
          </Text>
        </Html>
      </Tailwind>
    );
  }

  return (
    <Tailwind>
      <Html lang={props.locale}>
        <Text>
          <Heading className="text-red-500">Willkommen</Heading>
          <Text>Hallo {name},</Text>
          <Text></Text>
        </Text>
      </Html>
    </Tailwind>
  );
}
