import { createContext, type ReactNode, useContext, useState } from "react";

import { ServerDataContext } from "./ServerDataProvider";

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext({
  theme: "light" as Theme,
  setTheme: (theme: string) => {}, // Function to set the theme
});

export const ThemeProvider = (props: { children: ReactNode }) => {
  const { theme } = useContext(ServerDataContext);
  const [_theme, _setTheme] = useState(theme);

  return (
    <ThemeContext.Provider
      value={{
        theme: theme as Theme,
        setTheme: (newTheme: string) => {
          _setTheme((oldTheme) => {
            if (globalThis.cookieStore) {
              globalThis.cookieStore.set("theme", newTheme);
            } else {
              // Fallback for environments without cookieStore support
              document.cookie = `theme=${newTheme}; path=/; max-age=31536000;`;
            }
            document.documentElement.classList.remove(oldTheme);
            document.documentElement.classList.add(newTheme);
            return newTheme as Theme;
          });
        },
      }}
    >
      {props.children}
    </ThemeContext.Provider>
  );
};

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
}
