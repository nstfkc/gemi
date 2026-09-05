export default function _Redirect({ destination } = { destination: "/" }) {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `window.location.href="${destination}"`,
      }}
    />
  );
}
