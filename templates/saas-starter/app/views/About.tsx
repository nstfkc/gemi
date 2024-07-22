export default function About() {
  return (
    <div className="py-4">
      <div className="py-8">
        <p>
          Gemi, is a batteries included framework for building web applications.
          You can create server side rendered applications and create APIs.
        </p>
        <br />
        <p>
          It also provides wide range of features like authentication,
          authorization, database support, file uploads, email sending, etc. out
          of the box.
        </p>
        <br />
        It runs on{" "}
        <a
          target="_blank"
          className="font-bold"
          rel="noopener noreferrer"
          href="https://bun.sh"
        >
          bun
        </a>
        , uses{" "}
        <a
          target="_blank"
          className="font-bold"
          rel="noopener noreferrer"
          href="https://vitejs.dev"
        >
          vite
        </a>{" "}
        as a bundler and uses{" "}
        <a
          target="_blank"
          className="font-bold"
          rel="noopener noreferrer"
          href="https://react.dev"
        >
          React
        </a>{" "}
        in the frontend.
      </div>
      <div className="py-8">
        To learn more read the{" "}
        <a
          href="https://github.com/nstfkc/gemi/blob/main/README.md"
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold"
        >
          documentation
        </a>
      </div>
      <div>
        Visit{" "}
        <a
          className="font-bold"
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/nstfkc/gemi/issues"
        >
          <code>https://github.com/nstfkc/gemi/issues</code>
        </a>{" "}
        to report issues, ask questions or contribute.
      </div>
    </div>
  );
}
