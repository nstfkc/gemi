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
      const err = ${JSON.stringify(err)}
      window.addEventListener('load', () => {
        const container = document.getElementById('overlay')
        const ErrorOverlay = customElements.get('vite-error-overlay')
        if (ErrorOverlay) {
          const overlay = new ErrorOverlay(err)
          container.appendChild(overlay)
        }
      })
    </script>
  </body>
</html>
`;
}
