function cleanupTerminalText(text) {
  return (
    text
      // Remove ANSI escape sequences (colors, formatting)
      .replace(/\x1b\[[0-9;]*m/g, "")
      // Remove ANSI escape sequences with different format
      .replace(/\[[0-9;]*m/g, "")
      // Remove excessive whitespace and normalize line breaks
      .replace(/\n\s*\n/g, "\n")
      // Trim each line
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .trim()
  );
}

export function renderErrorPage(err: any) {
  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0"
    />

    <title>Error</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        padding: 20px;
      }
      h1 {
        color: red;
      }
    </style>
  </head>
  <body>
  <div id="overlay"></div>
    <script type="module" src="/refresh.js"></script>
    <script type="module" src="/@vite/client"></script>
    <script>
      ${cleanupTerminalText.toString()}
      const err = ${JSON.stringify(err, Object.getOwnPropertyNames(err), 2)}

      window.addEventListener('load', () => {
        const container = document.getElementById('overlay')
        const ErrorOverlay = customElements.get('vite-error-overlay')
        if (ErrorOverlay) {
      const overlay = new ErrorOverlay({ ...err, message: cleanupTerminalText(err.message) });
          container.appendChild(overlay)
        }
      })
    </script>
  </body>
</html>
`;
}
