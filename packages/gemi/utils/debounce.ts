export function debounce<U, T extends (...p: U[]) => void>(
  fn: T,
  delay: number,
) {
  let timeout: Timer;
  return function (...args: U[]) {
    const later = () => {
      clearTimeout(timeout);
      fn(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, delay);
  };
}
