// An island module for `islandLoader.test.ts`: records every mount on the
// marker, so a test can count them per element.
export default function mount(root, props) {
  root.dataset.mounts = String(Number(root.dataset.mounts ?? 0) + 1);
  root.dataset.received = JSON.stringify(props === undefined ? "undefined" : props);
}
