import { Link, useParams } from "gemi/client";

export default function Integration() {
  const params = useParams();
  const organisationId = params.organisationId;
  return (
    <div>
      <div>
        <h1>Integration</h1>
        <div>
          <Link href={`/map/${organisationId}`}>Preview</Link>
        </div>
      </div>
      <div></div>
    </div>
  );
}
