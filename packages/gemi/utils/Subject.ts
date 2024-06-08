export class Subject<T> {
  subscribers = new Set<(value: T) => void>();
  value: T;

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  public subscribe(subscriber: (value: T) => void) {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  public next(value: T) {
    this.value = value;
    this.subscribers.forEach((subscriber) => subscriber(value));
  }

  public getValue() {
    return this.value;
  }
}
