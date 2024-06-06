export function getCookies(req: Request): Map<string, string> {
  const cookies = req.headers.get("cookie");
  if (!cookies) {
    return new Map();
  }
  const _cookies = new Map();
  const cookieStrings = cookies.split(";");
  for (const cookieString of cookieStrings) {
    const [name, value] = cookieString.split("=");
    _cookies.set(name.trim(), value);
  }
  return _cookies;
}
