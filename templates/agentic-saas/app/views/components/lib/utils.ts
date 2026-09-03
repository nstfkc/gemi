import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// `clsx` resolves the conditionals and `twMerge` then drops the losers of any
// Tailwind conflict, so a caller-supplied `className` beats the component's own
// default instead of the two both landing in the class list and the winner
// being decided by stylesheet order.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
