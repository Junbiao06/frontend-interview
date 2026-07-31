## 0. 总结

```
普通函数的 this 由调用方式决定
obj.fn()：this 指向 obj
fn()：严格模式下指向 undefined
call、apply、bind：指定 this
new Fn()：this 指向新创建的实例
箭头函数：没有自己的 this，继承外层 this
```

## 1. 普通函数

普通函数的 `this` 取决于调用位置，而不是定义位置。

```js
const user = {
  name: 'Tom',
  getName() {
    return this.name;
  },
};

user.getName(); // "Tom"

const fn = user.getName;
fn(); // 调用者丢失
```

独立调用时，严格模式下 `this` 是 `undefined`；
非严格模式下，浏览器普通脚本中指向 `window`。

## 2. call、apply、bind

> 三者都可以指定普通函数的 `this`，区别在于参数形式和是否立即执行。

```js
function introduce(greeting, punctuation) {
  return `${greeting}，我是${this.name}${punctuation}`;
}

const user = { name: 'Tom' };

// call：立即执行，参数逐个传入。
introduce.call(user, '你好', '！');

// apply：立即执行，参数以数组传入。
introduce.apply(user, ['你好', '！']);

// bind：不立即执行，返回绑定 this 的新函数。
const introduceTom = introduce.bind(user, '你好');
introduceTom('！');
```

```
call：fn.call(thisArg, arg1, arg2)
apply：fn.apply(thisArg, [...arg])
bind：fn.bind(thisArg, arg1, arg2)，返回新函数
```

`bind` 还可以预先传入部分参数，之后调用新函数时再传入剩余参数。
箭头函数没有自己的 `this`，因此三者都不能改变箭头函数的 `this`。


| 方法     | call                                | apply                            | bind                                |
| ------ | ----------------------------------- | -------------------------------- | ----------------------------------- |
| 语法     | `fn.call(thisArg, arg1, arg2, ...)` | `fn.apply(thisArg, [argsArray])` | `fn.bind(thisArg, arg1, arg2, ...)` |
| 是否调用函数 | ✅                                   | ✅                                | ❌                                   |
| 改变this | ✅                                   | ✅                                | ✅                                   |
| 执行时机   | 立即调用函数                              | 立即调用函数                           | 返回新函数，可延迟执行                         |
| 参数传递   | 逐个传入                                | 数组传入                             | 逐个传入                                |
| 返回值    | 函数返回值                               | 函数返回值                            | 返回新函数（需再次调用）                        |
| 使用场景   | 简单调用                                | 需要数组处理                           | 延迟或回调（定时器）中绑定this                   |

## 3. new

使用 `new` 调用函数时，`this` 指向新创建的实例。

```js
function User(name) {
  this.name = name;
}

const user = new User('Tom');
```

实例化过程：
1. 创建空对象，其原型指向构造函数Constructor的 `prototype`。
2. 将构造函数的 `this` 指向新对象。
3. 执行构造函数。
4. 返回新对象。

## 4. 箭头函数

箭头函数没有自己的 `this`，会继承定义位置外层的 `this`。

```js
const user = {
  name: 'Tom',
  getName() {
    const fn = () => this.name;
    return fn();
  },
};

user.getName(); // "Tom"
```

## 5. 判断顺序

```
箭头函数：直接查找外层 this
普通函数：new → call/apply/bind → 对象调用 → 默认调用
```
