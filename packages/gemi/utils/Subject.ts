export class Subject<T> {
  subscribers = new Set<(value: T) => void>();
  value: T;

  constructor(initialValue: T) {
    this.value = initialValue;
    // Bound once, per instance, because these are read as plain functions:
    // `useSyncExternalStore(subject.subscribe, subject.getValue, …)` calls them
    // with no receiver, and an unbound method throws on `this.value`.
    //
    // Here rather than at each call site, and that part matters. Binding in a
    // hook body allocates a fresh function every render, and
    // `useSyncExternalStore` tears down and re-creates its subscription
    // whenever `subscribe` changes identity — so a component rendering a
    // navigation spinner would churn its entry in `subscribers` on every pass.
    // `next` iterates that set, and `Set.forEach` visits entries inserted
    // during iteration, so a value landing mid-resubscribe could notify both
    // the outgoing and the incoming subscriber. Binding here keeps the stable
    // prototype-method identity the call sites used to rely on.
    this.subscribe = this.subscribe.bind(this);
    this.next = this.next.bind(this);
    this.getValue = this.getValue.bind(this);
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
