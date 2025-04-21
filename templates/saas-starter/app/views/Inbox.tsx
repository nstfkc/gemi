export default function Inbox() {
  return (
    <div>
      <a href="#test">Test</a>
      {Array.from(Array(100)).map((_, i) => (
        <div key={i} className="p-4 border-b">
          <p>This is the content of inbox item {i + 1}.</p>
        </div>
      ))}
      <section id="test">Test</section>
      {Array.from(Array(100)).map((_, i) => (
        <div key={i} className="p-4 border-b">
          <p>This is the content of inbox item {i + 1}.</p>
        </div>
      ))}
    </div>
  );
}
