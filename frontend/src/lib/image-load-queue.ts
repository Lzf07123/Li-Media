export type ImageLoadPriority = "normal" | "high";

type ImageLoadOptions = {
  retries?: number;
  priority?: ImageLoadPriority;
  signal?: AbortSignal;
};

type QueueTask = {
  abort: () => void;
  attempt: number;
  image: HTMLImageElement;
  reject: (error: Error) => void;
  retries: number;
  retryTimer?: number;
  start: () => void;
  priority: ImageLoadPriority;
  sequence: number;
  signal?: AbortSignal;
  cleanup: () => void;
};

const MAX_ACTIVE_IMAGE_LOADS = 2;

class ImageLoadQueue {
  private activeCount = 0;
  private sequence = 0;
  private tasks: QueueTask[] = [];

  load(src: string, options: ImageLoadOptions = {}): Promise<HTMLImageElement> {
    const { priority = "normal", retries = 0, signal } = options;

    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      let isActive = false;
      let isSettled = false;

      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        image.onload = null;
        image.onerror = null;
      };

      const finish = () => {
        this.activeCount -= 1;
      };

      const abort = () => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        window.clearTimeout(task.retryTimer);
        cleanup();
        if (isActive) {
          this.activeCount -= 1;
          image.src = "";
          this.startNext();
        } else {
          this.remove(task);
        }
        reject(createAbortError());
      };

      const complete = () => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        cleanup();
        finish();
        resolve(image);
        this.startNext();
      };

      const fail = () => {
        if (isSettled) {
          return;
        }
        finish();

        if (task.attempt < task.retries && !signal?.aborted) {
          task.attempt += 1;
          image.src = "";
          task.retryTimer = window.setTimeout(() => {
            this.tasks.push(task);
            this.startNext();
          }, retryDelayMs(task.attempt));
          return;
        }

        isSettled = true;
        task.cleanup();
        image.src = "";
        reject(new Error("Image load failed"));
        this.startNext();
      };

      const task: QueueTask = {
        abort,
        attempt: 0,
        image,
        reject,
        retries: retries,
        priority,
        sequence: this.sequence++,
        signal,
        cleanup,
        start: () => {
          isActive = true;
          image.onload = complete;
          image.onerror = fail;
          image.src = src;
        },
      };

      signal?.addEventListener("abort", abort, { once: true });
      this.tasks.push(task);
      this.startNext();
    });
  }

  private startNext() {
    while (this.activeCount < MAX_ACTIVE_IMAGE_LOADS && this.tasks.length > 0) {
      const availableTasks = this.tasks.filter((task) => !task.signal?.aborted);
      if (availableTasks.length === 0) {
        this.tasks = this.tasks.filter((task) => !task.signal?.aborted);
        continue;
      }

      const task = availableTasks.reduce((selected, candidate) =>
        this.rank(candidate) < this.rank(selected) ? candidate : selected,
      );
      this.remove(task);

      this.activeCount += 1;
      task.start();
    }
  }

  private rank(task: QueueTask) {
    const priorityRank = task.priority === "high" ? 0 : 1;
    return priorityRank * Number.MAX_SAFE_INTEGER + task.sequence;
  }

  private remove(task: QueueTask) {
    const index = this.tasks.indexOf(task);
    if (index >= 0) {
      this.tasks.splice(index, 1);
    }
  }
}

function retryDelayMs(attempt: number) {
  return Math.min(4000, 500 * 2 ** Math.max(0, attempt - 1));
}

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("Image load aborted", "AbortError");
  }

  const error = new Error("Image load aborted");
  error.name = "AbortError";
  return error;
}

export const imageLoadQueue = new ImageLoadQueue();

export function loadQueuedImage(
  src: string,
  options: ImageLoadOptions = {},
): Promise<HTMLImageElement> {
  return imageLoadQueue.load(src, options);
}
