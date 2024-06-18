const result = await Bun.build({
  entrypoints: [
    "./http/index.ts",
    "./app/index.ts",
    "./facades/index.ts",
    "./email/index.ts",
    "./vite/index.ts",
  ],
  outdir: "./dist",
  external: ["vite", "react", "react-dom", "react/jsx-runtime"],
  target: "node",
  format: "esm",
  minify: false,
  splitting: false,
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
