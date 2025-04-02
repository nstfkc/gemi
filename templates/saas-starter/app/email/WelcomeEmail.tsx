import { Email } from "gemi/email";

export class WelcomeEmail extends Email {
  subject = "Welcome to our platform";

  template = (props: { name: string }) => {
    return <div>Welcome, {props.name}</div>;
  };
}
