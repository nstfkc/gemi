import { rmdir } from "node:fs/promises";

try {
  await rmdir("dist", { recursive: true });
} catch (err) {}

const result = await Bun.build({
  entrypoints: [
    "./http/index.ts",
    "./app/index.ts",
    "./facades/index.ts",
    "./email/index.ts",
    "./vite/index.ts",
    "./server/index.ts",
    "./kernel/index.ts",
    "./services/index.ts",
    "./broadcasting/index.ts",
    "./i18n/index.ts",
  ],
  outdir: "./dist",
  external: [
    "vite",
    "react",
    "react-dom",
    "react/jsx-runtime",
    "bun",
    "jsx-email",
  ],
  target: "bun",
  format: "esm",
  minify: true,
  splitting: true,
  sourcemap: "external",
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) {
    // Bun will pretty print the message object
    console.error(message);
  }
} else {
  result.logs.forEach((message) => {
    console.log(message);
  });

  result.outputs.forEach((output) => {
    console.log(output.path);
  });

  console.log("Build succeeded");
}
