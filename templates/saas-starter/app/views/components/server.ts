export function server() {
  console.log("This is the server");
}
if (typeof window !== "undefined") {
  window.__test__ = "HI";
  console.log("This is the client");
}
