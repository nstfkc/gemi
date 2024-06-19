// tailwind.config.js

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/views/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Arial", "sans-serif"],
      },
    },
  },
  darkMode: "class",
  plugins: [],
};
