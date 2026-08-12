import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext({
  theme: "light" as Theme,
  setTheme: (theme: Theme) => {}, // Function to set the theme
});

function storeTheme(theme: string) {
  try {
    localStorage.setItem("theme", theme);
  } catch (error) {
    console.error("Failed to store theme in localStorage:", error);
  }
}

export const ThemeProvider = (props: {
  children: ReactNode;
  /**
   * The theme to start on, ahead of the stored one. The app leaves this unset —
   * a visitor's choice lives in `localStorage` — but a test has no browser
   * session to have made that choice in, so `gemi/testing`'s `<Page>` passes
   * it through to render a component in a theme without writing to storage.
   */
  theme?: Theme;
}) => {
  const [theme, setTheme] = useState(() => {
    if (props.theme) {
      return props.theme;
    }
    if (typeof window === "undefined") {
      return "light"; // Default theme for server-side rendering
    }
    return localStorage.getItem("theme") || "light";
  });

  useEffect(() => {
    if (theme === "system") {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", ({ matches }) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(matches ? "dark" : "light");
        });
    }
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{
        theme: theme as Theme,
        setTheme: (newTheme: Theme) => {
          setTheme(newTheme);
          storeTheme(newTheme);

          let documentTheme = newTheme as Theme;
          if (newTheme === "system") {
            const media = window.matchMedia("(prefers-color-scheme: dark)");
            documentTheme = media.matches ? "dark" : "light";
          }
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(documentTheme);
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
