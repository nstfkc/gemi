import { Link } from "gemi/client";

export default function Logs(props) {
  return (
    <div>
      {props.files.map((file) => {
        return (
          <div key={file}>
            <Link href={`/${file}`.replace("logs", "log")}>{file}</Link>
          </div>
        );
      })}
    </div>
  );
}
