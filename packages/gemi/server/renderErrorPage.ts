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
    <h1>Error</h1>
    <pre>${JSON.stringify(err, null, 2)}</pre>
    <script type="module" src="/refresh.js"></script>
  </body>
</html>
`;
}
