export function generateETag(lastModified: number): string {
  // Assuming the last modified timestamp is in milliseconds
  const lastModifiedStr = lastModified.toString();

  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(lastModifiedStr);
  const hash = hasher.digest("hex");

  return hash;
}
