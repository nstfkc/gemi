class I18NDictionary {}

interface II18NComponent {
  dictionary: Readonly<Record<string, Record<string, string>>>;
}

class I18NComponent implements II18NComponent {
  dictionary = {} as any;
  static reference<
    T extends new () => I18NComponent,
    K extends keyof InstanceType<T>["dictionary"],
  >(this: T, key: K): InstanceType<T>["dictionary"][K] {
    const instance = new this();
    return instance.dictionary[key];
  }
}

class SignUp extends I18NComponent {
  dictionary = {
    "sign-up": {
      default: "Sign Up",
      "de-DE": "Registrieren",
    },
    submit: {
      default: "Submit",
      "de-DE": "Einreichen",
    },
  };
}

class SignIn extends I18NComponent {
  dictionary = {
    "sign-in": {
      default: "Sign In",
      "de-DE": (test: string) => `Anmelden ${test}`,
    },
    "forgot-password": SignUp.reference("submit"),
  };
}

class I18NServiceProvider {
  components = {};
}

class CustomI18NServiceProvider extends I18NServiceProvider {
  components = {
    SignUp,
    SignIn,
  };
}

type ParseComponent<T> = {
  [K in keyof T]: T[K] extends typeof I18NComponent
    ? InstanceType<T[K]>["dictionary"]
    : never;
};

type Parser<T> = T extends I18NServiceProvider
  ? ParseComponent<T["components"]>
  : never;

type Result = Parser<CustomI18NServiceProvider>;
