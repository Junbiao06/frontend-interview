```js
const FULFILLED = "fulfilled";
const REJECTED = "rejected";
const PENDING = "pending";

const isObject = (val) => typeof val === "object" && val !== null;
const isFunction = (val) => typeof val === "function";
// thenable
const isthenable = (val) =>
  (isObject(val) || isFunction(val)) && isFunction(val.then);

// promise：最终要被修改状态的目标 Promise
// x：拿来决定目标 Promise 最终状态和值的数据
const resolvePromise = (promise, x) => {
  if (promise._state !== PENDING) return;

  if (isthenable(x)) {
    // 1. x 和 promise 是同一个对象，抛出异常
    if (x === promise) {
      rejectPromise(
        promise,
        new TypeError("Chaining cycle detected for promise #<Promise>"),
      );
      return;
    }
    // 2. 吸收状态
    queueMicrotask(() => {
      x.then(
        (data) => resolvePromise(promise, data),
        (error) => rejectPromise(promise, error),
      );
    });
  } else {
    promise._state = FULFILLED;
    promise._data = x;
    _flushHandlers(promise);
  }
};

const rejectPromise = (promise, reason) => {
  if (promise._state !== PENDING) return;
  promise._state = REJECTED;
  promise._reason = reason;
  _flushHandlers(promise);
};

// 处理后续的回调
const _flushHandlers = (curPromise) => {
  if (curPromise._state === PENDING) return;
  const settledHandlers = curPromise._settledHandles;
  queueMicrotask(() => {
    while (settledHandlers.length) {
      const handler = settledHandlers.shift();
      const { onFulfilled, onRejected, promise } = handler;
      // curPromise fulfilled，回调不是函数，状态穿透（就是忽略的意思）
      if (!isFunction(onFulfilled) && curPromise._state === FULFILLED) {
        resolvePromise(promise, curPromise._data);
        continue;
      }

      // curPromise rejected，回调不是函数，状态穿透（就是忽略的意思）
      if (!isFunction(onRejected) && curPromise._state === REJECTED) {
        rejectPromise(promise, curPromise._reason);
        continue;
      }

      let result;
      try {
        result =
          curPromise._state === FULFILLED
            ? onFulfilled(curPromise._data)
            : onRejected(curPromise._reason);
      } catch (error) {
        rejectPromise(promise, error);
        continue;
      }
      resolvePromise(promise, result);
    }
  });
};

class MyPromise {
  _state = PENDING;
  _data = undefined;
  _reason = undefined;
  _settledHandles = []; // 存储 then 的回调函数

  constructor(executor) {
    const resolve = (data) => {
      resolvePromise(this, data);
    };
    const reject = (error) => {
      rejectPromise(this, error);
    };
    try {
      executor(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }

  then(onFulfilled, onRejected) {
    const promise = new MyPromise(() => {});
    this._settledHandles.push({
      onFulfilled,
      onRejected,
      promise,
    });
    _flushHandlers(this);
    return promise;
  }
}

// const p1 = new MyPromise((resolve, reject) => {
//   setTimeout(() => {
//     resolve(p1);
//   }, 1000);
// });

// setTimeout(() => {
//   console.log(p1);
// }, 1000);

const p2 = new MyPromise((resolve) => resolve(1));
const p3 = new MyPromise((resolve, reject) => resolve(p2));
// console.log(p3);
// queueMicrotask(() => console.log(p3));
queueMicrotask(() => queueMicrotask(() => console.log(p3)));

```