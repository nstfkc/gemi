export default function Log(props) {
  return (
    <div>
      {props.lines.map((line) => (
        <div key={line.timestamp}>{line.timestamp}</div>
      ))}
    </div>
  );
}
