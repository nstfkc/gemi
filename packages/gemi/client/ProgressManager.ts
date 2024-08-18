import { Subject } from "../utils/Subject";
import { sleep } from "../utils/sleep";

export class ProgressManager {
  state = new Subject(100);
  unsubscribe: ReturnType<InstanceType<typeof Subject>["subscribe"]>;
  timer: ReturnType<typeof setInterval>;
  tick = 0;
  isTicking = false;

  constructor(subject: Subject<boolean>) {
    this.unsubscribe = subject.subscribe((state) => {
      if (state) {
        this.start();
      } else {
        this.end();
      }
    });
  }

  getNextIncrement() {
    const current = this.state.getValue();
    if (current === 100) {
      return Math.ceil(Math.random() * 10);
    }

    if (current <= 20) {
      if (Math.ceil(Math.random() * 100) > 80) {
        return current;
      }
      return current + Math.ceil(Math.random() * 5) + 1;
    }

    if (current <= 50) {
      if (Math.ceil(Math.random() * 100) > 50) {
        return current;
      }
      return Math.min(current + Math.ceil(Math.random() * 10), 70);
    }

    if (current <= 70) {
      if (Math.ceil(Math.random() * 100) > 60) {
        return current;
      }
      return Math.min(current + Math.ceil(Math.random() * 3), 80);
    }

    if (current <= 80) {
      return Math.min(current + Math.ceil(Math.random() * 1), 90);
    }

    if (current <= 90) {
      const x = Math.ceil(Math.random() * 100) > 50 ? 0 : 1;
      return Math.min(current + x, 94);
    }

    if (current <= 94) {
      const x = Math.ceil(Math.random() * 100) > 20 ? 0 : 1;
      return Math.min(current + x, 99);
    }
  }

  getNextInterval() {
    if (this.tick === 0) {
      this.tick = 1;
      return 200;
    }
    const current = this.state.getValue();

    if (current >= 88) {
      return 400;
    }
    if (current >= 94) {
      return 1000;
    }
    if (current >= 98) {
      return 2000;
    }
    return 100;
  }

  async nextTick() {
    if (!this.isTicking) {
      return;
    }
    await sleep(this.getNextInterval());

    if (!this.isTicking) {
      return;
    }

    const increment = this.getNextIncrement();
    this.state.next(Math.min(increment, 96));

    await this.nextTick();
  }

  start() {
    this.isTicking = true;
    this.nextTick();
  }

  end() {
    this.state.next(99);
    this.isTicking = false;
    this.tick = 0;
    setTimeout(() => {
      this.state.next(100);
    }, 200);
  }

  destroy() {
    this.unsubscribe();
  }
}
