import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

export const ThemeProvider = (props: { children: ReactNode }) => {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") {
      return "light"; // Default theme for server-side rendering
    }
    return localStorage.getItem("theme") || "light";
  });

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = ({ matches }: MediaQueryListEvent) => {
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setThemeAndStore = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
    storeTheme(newTheme);

    let documentTheme = newTheme as Theme;
    if (newTheme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      documentTheme = media.matches ? "dark" : "light";
    }
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(documentTheme);
  }, []);

  const value = useMemo(
    () => ({ theme: theme as Theme, setTheme: setThemeAndStore }),
    [theme, setThemeAndStore],
  );

  return (
    <ThemeContext.Provider value={value}>
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
